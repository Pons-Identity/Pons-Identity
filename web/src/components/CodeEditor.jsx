import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, FormHelperText, Menu, MenuItem, Stack, Typography, useTheme } from '@mui/material';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { redo, selectAll, undo } from '@codemirror/commands';
import { gotoLine, openSearchPanel } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { basicSetup } from 'codemirror';
import { useNotify } from './Notify.jsx';
import { buildReferenceDocs, codeHover, hoverTheme } from './codeHover.js';
import { codeCompletion } from './codeComplete.js';

// A code editor (CodeMirror) with File, Edit and Go menus above it and a status line below: where the cursor is, and how long the
// text is. `value` and `onChange` work like a text field's; `disabled` makes it read-only. `reference` is the script reference from
// the server (integrations/docs.js): with it, hovering a name shows what it takes, returns and an example. Plain JavaScript
// built-ins are documented without it. `variables` are the names the Inputs table gives the script, offered as completions.
// Where the cursor is, and how many lines the text has.
const statusOf = (state) => {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1, lines: state.doc.lines };
};

// CodeMirror's default look is light only; this follows the page's palette so the editor reads in either mode.
const paletteTheme = (palette) => EditorView.theme({
  '&': { color: palette.text.primary, backgroundColor: palette.background.paper },
  '.cm-content': { caretColor: palette.text.primary },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: palette.text.primary },
  '.cm-gutters': { backgroundColor: palette.action.hover, color: palette.text.secondary, border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: palette.action.hover },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: palette.action.selected },
  '.cm-panels': { backgroundColor: palette.background.paper, color: palette.text.primary },
  '.cm-tooltip': { backgroundColor: palette.background.paper, color: palette.text.primary, border: `1px solid ${palette.divider}` },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: palette.action.selected, color: palette.text.primary },
  '.cm-doc-tip pre, .cm-doc-list': { color: palette.text.primary },
  '.cm-doc-label, .cm-doc-row': { color: palette.text.secondary },
}, { dark: palette.mode === 'dark' });

export default function CodeEditor({ label, value, onChange, disabled = false, fileName = 'script.js', helperText, error = false, reference, variables }) {
  const notify = useNotify();
  const { palette } = useTheme();
  const [themeSlot] = useState(() => new Compartment());
  const [hoverSlot] = useState(() => new Compartment());
  const variablesKey = (variables || []).join('\n');
  // Hover tips and completions, both built from the reference.
  const hover = useMemo(() => {
    const docs = buildReferenceDocs(reference);
    const names = variablesKey ? variablesKey.split('\n') : [];
    return [codeHover(docs, { reference, variables: names }), codeCompletion({ docs, reference, variables: names })];
  }, [reference, variablesKey]);
  const host = useRef(null);
  const fileInput = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [editable] = useState(() => new Compartment());
  const [menu, setMenu] = useState(null);
  const [status, setStatus] = useState({ line: 1, col: 1, lines: 1 });

  useEffect(() => {
    const view = new EditorView({
      parent: host.current,
      doc: value,
      extensions: [
        basicSetup,
        javascript(),
        themeSlot.of(paletteTheme(palette)),
        hoverTheme,
        hoverSlot.of(hover),
        editable.of([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]),
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) setStatus(statusOf(update.state));
        }),
      ],
    });
    viewRef.current = view;
    setStatus(statusOf(view.state));
    return () => view.destroy();
    // Created once; later changes come through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current.dispatch({ effects: themeSlot.reconfigure(paletteTheme(palette)) });
  }, [palette, themeSlot]);

  useEffect(() => {
    viewRef.current.dispatch({ effects: hoverSlot.reconfigure(hover) });
  }, [hover, hoverSlot]);

  useEffect(() => {
    const view = viewRef.current;
    if (view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) });
  }, [disabled, editable]);

  const selected = () => { const r = viewRef.current.state.selection.main; return viewRef.current.state.sliceDoc(r.from, r.to); };
  const focus = () => viewRef.current.focus();

  async function copy() {
    try { await navigator.clipboard.writeText(selected()); } catch { notify('Copying is blocked here. Use Ctrl+C or Cmd+C.'); }
  }
  async function cut() {
    const text = selected();
    if (!text) return;
    await copy();
    viewRef.current.dispatch(viewRef.current.state.replaceSelection(''));
  }
  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      viewRef.current.dispatch(viewRef.current.state.replaceSelection(text));
    } catch { notify('Pasting is blocked here. Use Ctrl+V or Cmd+V.'); }
  }
  function saveAs() {
    const url = URL.createObjectURL(new Blob([viewRef.current.state.doc.toString()], { type: 'text/javascript' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const view = viewRef.current;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }

  // Each action is run from the editor's own view, which then takes focus back.
  const act = (run) => () => { run(); focus(); };
  const menus = {
    File: [
      { label: 'Open file…', run: () => fileInput.current.click(), disabled },
      { label: 'Save as…', run: saveAs },
    ],
    Edit: [
      { label: 'Undo', run: act(() => undo(viewRef.current)), disabled },
      { label: 'Redo', run: act(() => redo(viewRef.current)), disabled },
      { label: 'Cut', run: cut, disabled },
      { label: 'Copy', run: copy },
      { label: 'Paste', run: paste, disabled },
      { label: 'Select all', run: act(() => selectAll(viewRef.current)) },
    ],
    Go: [
      { label: 'Find…', run: act(() => openSearchPanel(viewRef.current)) },
      { label: 'Find and replace…', run: act(() => openSearchPanel(viewRef.current)), disabled },
      { label: 'Go to line…', run: act(() => gotoLine(viewRef.current)) },
    ],
  };

  return (
    <Box>
      <Typography variant="body2" component="span" sx={{ display: 'block', mb: 0.5, color: error ? 'error.main' : 'text.secondary' }}>{label}</Typography>
      <Box sx={{ border: 1, borderColor: error ? 'error.main' : 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.paper' }}>
        <Stack direction="row" role="toolbar" aria-label={`${label} menus`} sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover', px: 0.5 }}>
          {Object.keys(menus).map((name) => (
            <Button key={name} size="small" aria-haspopup="menu" aria-expanded={menu?.name === name ? 'true' : undefined}
              onClick={(e) => setMenu({ name, anchor: e.currentTarget })}>{name}</Button>
          ))}
          <input ref={fileInput} type="file" accept=".js,.txt,text/javascript,text/plain" hidden aria-label={`${label} file`} onChange={upload} />
        </Stack>
        <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={() => setMenu(null)}>
          {(menus[menu?.name] || []).map((item) => (
            <MenuItem key={item.label} disabled={item.disabled} onClick={() => { setMenu(null); item.run(); }}>{item.label}</MenuItem>
          ))}
        </Menu>
        <Box ref={host} sx={{
          '& .cm-editor': { maxHeight: '60vh', fontSize: 13 },
          '& .cm-editor.cm-focused': { outline: 'none' },
          '& .cm-scroller': { fontFamily: 'monospace', minHeight: 240 },
        }} />
        <Stack direction="row" justifyContent="space-between" sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover', px: 1.5, py: 0.25 }}>
          <Typography variant="caption" color="text.secondary">Ln {status.line}, Col {status.col}</Typography>
          <Typography variant="caption" color="text.secondary">{status.lines} {status.lines === 1 ? 'line' : 'lines'} · JavaScript</Typography>
        </Stack>
      </Box>
      {helperText && <FormHelperText error={error}>{helperText}</FormHelperText>}
    </Box>
  );
}
