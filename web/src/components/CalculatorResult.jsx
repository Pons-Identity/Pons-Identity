import { useEffect, useState } from 'react';
import { Alert, Box, Paper, Stack, Tab, Tabs, Typography } from '@mui/material';
import { api } from '../api/client.js';
import CalculatorDiagram from './CalculatorDiagram.jsx';
import CopyButton from './CopyButton.jsx';

const KEY = 'simpleidp.calculator.view';
const VIEWS = ['text', 'horizontal', 'vertical'];
// 'diagram' was the one diagram view before the vertical layout was added; a saved choice of it means the horizontal one.
const readView = () => { try { const v = localStorage.getItem(KEY); return v === 'diagram' ? 'horizontal' : VIEWS.includes(v) ? v : 'text'; } catch { return 'text'; } };
const saveView = (v) => { try { localStorage.setItem(KEY, v); } catch { /* optional */ } };

/**
 * A calculator's answer in two forms: the plain text, which says everything, and the interactive diagram, which shows the same
 * facts as connections. `result` is what the server returned ({ text, mermaid, graph }). `summary` sits above both.
 */
export default function CalculatorResult({ result, summary = null }) {
  const [view, setView] = useState(readView);
  const change = (_, next) => { setView(next); saveView(next); };
  return (
    <Stack spacing={2}>
      {summary}
      <Paper variant="outlined">
        <Box sx={{ borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1, flexWrap: 'wrap' }}>
          <Tabs value={view} onChange={change} aria-label="Result view">
            <Tab value="text" label="Text" id="calc-tab-text" aria-controls="calc-panel" />
            <Tab value="horizontal" label="Horizontal diagram" id="calc-tab-horizontal" aria-controls="calc-panel" />
            <Tab value="vertical" label="Vertical diagram" id="calc-tab-vertical" aria-controls="calc-panel" />
          </Tabs>
          {view === 'text' && <CopyButton value={result.text} label="Copy text" />}
        </Box>
        <Box role="tabpanel" id="calc-panel" aria-labelledby={`calc-tab-${view}`} sx={{ p: 2 }}>
          {view === 'text' ? (
            <Box component="pre" tabIndex={0} aria-label="Calculator result as text" sx={{ m: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {result.text}
            </Box>
          ) : (
            <CalculatorDiagram key={view} mermaid={view === 'vertical' ? result.mermaid_vertical : result.mermaid} graph={result.graph} />
          )}
        </Box>
      </Paper>
    </Stack>
  );
}

export function CalculatorError({ message }) {
  return message ? <Alert severity="error">{message}</Alert> : null;
}

/** Asks the server for a calculator's answer whenever `path` changes (null asks for nothing). Late answers to old questions are dropped. */
export function useCalculation(path) {
  const [state, setState] = useState({ result: null, error: '', loading: false });
  useEffect(() => {
    if (!path) { setState({ result: null, error: '', loading: false }); return undefined; }
    let stale = false;
    setState((s) => ({ ...s, loading: true, error: '' }));
    api(path).then(
      (result) => { if (!stale) setState({ result, error: '', loading: false }); },
      (err) => { if (!stale) setState({ result: null, error: err.message, loading: false }); },
    );
    return () => { stale = true; };
  }, [path]);
  return state;
}
