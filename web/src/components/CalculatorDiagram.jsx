import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Fade, IconButton, Popper, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import DownloadIcon from '@mui/icons-material/Download';
import { useNavigate } from 'react-router-dom';
import CopyButton from './CopyButton.jsx';

// How the calculators' diagram classes are drawn (see src/calculator-graph.js). Colors come in pairs so the diagram reads on a
// light page and a dark one; the stroke carries the meaning, the fill only tints.
const PALETTE = {
  user: ['#1976d2', '#e3f2fd', '#0d3a66'], role: ['#5e35b1', '#ede7f6', '#2f1d5c'], basis: ['#2e7d32', '#e8f5e9', '#14391a'],
  reference: ['#b28704', '#fff8e1', '#4a3a05'], application: ['#00796b', '#e0f2f1', '#0b3a35'], policy: ['#ef6c00', '#fff3e0', '#523008'],
  global: ['#c2185b', '#fce4ec', '#5a0d2c'], app: ['#3949ab', '#e8eaf6', '#1c2557'], rule: ['#8e24aa', '#f3e5f5', '#41174d'],
  ok: ['#2e7d32', '#c8e6c9', '#14391a'], warn: ['#f57f17', '#ffecb3', '#5c3a05'], bad: ['#c62828', '#ffcdd2', '#5c1313'],
  muted: ['#757575', '#f5f5f5', '#2b2b2b'], target: ['#1976d2', '#bbdefb', '#0d3a66'],
};
export const LEGEND = [
  ['user', 'Person'], ['role', 'Role'], ['basis', 'Basis group'], ['reference', 'Reference group'], ['application', 'Application group'],
  ['policy', 'Policy'], ['global', 'Global policy'], ['rule', 'Result of rules'], ['app', 'Application'], ['muted', 'Not a member / source'],
];

export function classDefs(mode) {
  const dark = mode === 'dark';
  return Object.entries(PALETTE).map(([name, [stroke, light, deep]]) =>
    `  classDef ${name} fill:${dark ? deep : light},stroke:${stroke},stroke-width:2px,color:${dark ? '#f5f5f5' : '#1b1b1b'}${name === 'muted' ? ',stroke-dasharray:4 3' : ''}`).join('\n');
}

let counter = 0;
const ZOOM = { min: 0.4, max: 3, step: 0.2 };
const TIP_DELAY = 600;

/**
 * Draws a calculator's diagram with Mermaid. Mermaid is large, so it is loaded the first time a diagram is shown. `graph` is the
 * server's { nodes, edges, links }: a click on a box opens the thing it stands for (`links`), and pointing at one dims everything
 * not connected to it, so a route can be followed through a crowded diagram.
 */
export default function CalculatorDiagram({ mermaid, graph }) {
  const theme = useTheme();
  const navigate = useNavigate();
  const host = useRef(null);
  const [state, setState] = useState({ svg: '', error: '', busy: true });
  const [zoom, setZoom] = useState(1);
  // The tooltip shown for a box: the box's element and its text. `open` is false while it fades out.
  const [tip, setTip] = useState(null);
  const tipTimer = useRef(null);
  const source = useMemo(() => `${mermaid}\n${classDefs(theme.palette.mode)}`, [mermaid, theme.palette.mode]);
  const hideTip = useCallback(() => {
    clearTimeout(tipTimer.current);
    setTip((t) => (t && t.open ? { ...t, open: false } : t));
  }, []);
  // Popper places the tooltip against the box's live position, so it follows scrolling.
  const anchorEl = useMemo(() => (tip ? { getBoundingClientRect: () => tip.el.getBoundingClientRect() } : null), [tip?.el]);

  useEffect(() => {
    let stale = false;
    setState((s) => ({ ...s, busy: true, error: '' }));
    (async () => {
      try {
        const { default: lib } = await import('mermaid');
        lib.initialize({
          startOnLoad: false, securityLevel: 'strict', theme: theme.palette.mode === 'dark' ? 'dark' : 'default',
          flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: false }, maxTextSize: 200000,
        });
        counter += 1;
        const { svg } = await lib.render(`calculator-diagram-${counter}`, source);
        if (!stale) setState({ svg, error: '', busy: false });
      } catch (e) {
        if (!stale) setState({ svg: '', error: e?.message || 'The diagram could not be drawn.', busy: false });
      }
    })();
    return () => { stale = true; };
  }, [source, theme.palette.mode]);

  // Once the picture is in the page, make its boxes behave: open on click or Enter, and trace connections on hover or focus.
  useEffect(() => {
    const root = host.current;
    if (!root || !state.svg) return undefined;
    const boxes = new Map();
    for (const el of root.querySelectorAll('g.node')) {
      const m = /^(?:flowchart-)?(.+?)-\d+$/.exec(el.id || '');
      if (m) boxes.set(m[1], el);
    }
    // Mermaid names each line L_<from>_<to>_<n>, and lists the labels in the order the lines were written.
    const labels = [...root.querySelectorAll('.edgeLabels .edgeLabel')];
    const lines = [...root.querySelectorAll('path.flowchart-link')].map((el) => {
      const index = graph.edges.findIndex((e) => (el.getAttribute('data-id') || el.id || '').startsWith(`L_${e.from}_${e.to}_`));
      return { el, edge: graph.edges[index], label: labels.length === graph.edges.length ? labels[index] : null };
    });
    const neighbours = (id) => {
      const set = new Set([id]);
      for (const e of graph.edges) { if (e.from === id) set.add(e.to); if (e.to === id) set.add(e.from); }
      return set;
    };
    const trace = (id) => {
      const near = id === null ? null : neighbours(id);
      for (const [other, el] of boxes) el.style.opacity = near && !near.has(other) ? '0.25' : '';
      for (const { el, edge, label } of lines) {
        const touches = id !== null && edge && (edge.from === id || edge.to === id);
        el.style.opacity = id === null || touches ? '' : '0.15';
        el.style.strokeWidth = touches ? '3px' : '';
        if (label) label.style.opacity = id === null || touches ? '' : '0.15';
      }
    };
    const undo = [];
    for (const [id, el] of boxes) {
      const link = graph.links[id];
      const node = graph.nodes.find((n) => n.id === id);
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', link ? 'link' : 'img');
      el.setAttribute('aria-label', `${node?.label || id}${node?.details ? `. ${node.details.replace(/\n/g, '; ')}` : ''}`);
      el.style.cursor = link ? 'pointer' : 'default';
      const over = () => {
        trace(id);
        if (!node?.details) return;
        clearTimeout(tipTimer.current);
        tipTimer.current = setTimeout(() => setTip({ el, text: node.details, open: true }), TIP_DELAY);
      };
      const out = () => { trace(null); hideTip(); };
      const go = () => { hideTip(); if (link) navigate(link); };
      const key = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      el.addEventListener('mouseenter', over); el.addEventListener('mouseleave', out);
      el.addEventListener('focus', over); el.addEventListener('blur', out);
      el.addEventListener('click', go); el.addEventListener('keydown', key);
      undo.push(() => {
        el.removeEventListener('mouseenter', over); el.removeEventListener('mouseleave', out);
        el.removeEventListener('focus', over); el.removeEventListener('blur', out);
        el.removeEventListener('click', go); el.removeEventListener('keydown', key);
      });
    }
    return () => { undo.forEach((f) => f()); hideTip(); };
  }, [state.svg, graph, navigate, hideTip]);

  function download() {
    const url = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'calculator-diagram.svg';
    a.click();
    URL.revokeObjectURL(url);
  }
  const zoomBy = (d) => {
    hideTip(); // a tooltip would be left pointing at the wrong place once the picture is scaled
    setZoom((z) => Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round((z + d) * 10) / 10)));
  };

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Tooltip title="Zoom out"><span><IconButton size="small" aria-label="Zoom out" onClick={() => zoomBy(-ZOOM.step)} disabled={zoom <= ZOOM.min}><ZoomOutIcon /></IconButton></span></Tooltip>
        <Typography variant="body2" sx={{ minWidth: 40, textAlign: 'center' }} aria-live="polite">{Math.round(zoom * 100)}%</Typography>
        <Tooltip title="Zoom in"><span><IconButton size="small" aria-label="Zoom in" onClick={() => zoomBy(ZOOM.step)} disabled={zoom >= ZOOM.max}><ZoomInIcon /></IconButton></span></Tooltip>
        <Tooltip title="Actual size"><IconButton size="small" aria-label="Actual size" onClick={() => setZoom(1)}><FitScreenIcon /></IconButton></Tooltip>
        <Button size="small" startIcon={<DownloadIcon />} onClick={download} disabled={!state.svg}>Download SVG</Button>
        <CopyButton value={mermaid} label="Copy Mermaid source" />
      </Stack>
      {graph.truncated && <Alert severity="info">This diagram is large, so some parts are left out. The text version lists everything.</Alert>}
      {state.error && <Alert severity="error">The diagram could not be drawn: {state.error} The text version has the same information.</Alert>}
      {state.busy && !state.error && <Typography color="text.secondary">Drawing the diagram…</Typography>}
      <Popper open={Boolean(tip?.open)} anchorEl={anchorEl} placement="top" transition modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]} sx={{ pointerEvents: 'none' }}>
        {({ TransitionProps }) => (
          <Fade {...TransitionProps} timeout={200}>
            <Box sx={{ bgcolor: '#000', color: '#fff', px: 1, py: 0.5, borderRadius: 1, maxWidth: 320, fontSize: 12, lineHeight: 1.45, whiteSpace: 'pre-line', boxShadow: 2 }}>
              {tip?.text}
            </Box>
          </Fade>
        )}
      </Popper>
      <Box sx={{ overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, p: 1, maxHeight: '65vh', bgcolor: 'background.paper' }}>
        <Box ref={host} data-testid="diagram" sx={{ width: 'max-content', transform: `scale(${zoom})`, transformOrigin: 'top left', '& svg': { maxWidth: 'none', height: 'auto' } }}
          dangerouslySetInnerHTML={{ __html: state.svg }} />
      </Box>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap aria-label="Legend">
        {LEGEND.map(([name, label]) => (
          <Stack key={name} direction="row" spacing={0.75} alignItems="center">
            <Box sx={{ width: 14, height: 14, borderRadius: 0.5, border: 2, borderColor: PALETTE[name][0], bgcolor: theme.palette.mode === 'dark' ? PALETTE[name][2] : PALETTE[name][1], borderStyle: name === 'muted' ? 'dashed' : 'solid' }} />
            <Typography variant="caption">{label}</Typography>
          </Stack>
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary">Click a box to open it. Point at a box to trace what connects to it; a red line removes or blocks.</Typography>
    </Stack>
  );
}
