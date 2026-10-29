import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Box, Button, FormHelperText, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Typography, useTheme } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { redo, selectAll, undo } from '@codemirror/commands';
import { gotoLine, openSearchPanel } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { basicSetup } from 'codemirror';
import { useNotify } from './Notify.jsx';
import { buildReferenceDocs, codeHover, hoverTheme } from './codeHover.js';
import { codeCompletion } from './codeComplete.js';

// A code editor (CodeMirror) used for integration scripts and for the sign-in page's HTML and CSS. Above it are File, Edit, Go and
// View menus; below it, where the cursor is, how many lines there are, and the language and indentation, which can be changed there.
// `value` and `onChange` work like a text field's; `disabled` makes it read-only. For JavaScript, `reference` is the script reference
// from the server (integrations/docs.js): hovering a name shows what it takes, returns and an example. `variables` are the names the
// Inputs table gives the script, offered as completions. For other languages, `hover` is the hover tips for the editor's own language
// (`language`). `maxLength` refuses text past a limit. `ref` gives { insert(text) }: text goes in at the cursor.

const LANGUAGES = {
  javascript: { label: 'JavaScript', ext: 'js', mime: 'text/javascript', load: () => javascript() },
  css: { label: 'CSS', ext: 'css', mime: 'text/css', load: () => css() },
  html: { label: 'HTML', ext: 'html', mime: 'text/html', load: () => html() },
  text: { label: 'Plain text', ext: 'txt', mime: 'text/plain', load: () => [] },
};
const TAB_SIZES = [2, 4, 8];

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

const WRAP_ON = EditorView.lineWrapping;
const NUMBERS_OFF = EditorView.theme({ '.cm-gutters': { display: 'none' } });

const CodeEditor = forwardRef(function CodeEditor({
  label, value, onChange, disabled = false, fileName = 'script.js', helperText, error = false, reference, variables,
  language = 'javascript', hover, maxLength, wordWrap = false, languages = Object.keys(LANGUAGES),
}, ref) {
  const notify = useNotify();
  const { palette } = useTheme();
  const [themeSlot] = useState(() => new Compartment());
  const [hoverSlot] = useState(() => new Compartment());
  const [langSlot] = useState(() => new Compartment());
  const [tabSlot] = useState(() => new Compartment());
  const [wrapSlot] = useState(() => new Compartment());
  const [numberSlot] = useState(() => new Compartment());
  const [editable] = useState(() => new Compartment());
  const variablesKey = (variables || []).join('\n');
  // Hover tips and completions for JavaScript, both built from the reference.
  const jsHover = useMemo(() => {
    const docs = buildReferenceDocs(reference);
    const names = variablesKey ? variablesKey.split('\n') : [];
    return [codeHover(docs, { reference, variables: names }), codeCompletion({ docs, reference, variables: names })];
  }, [reference, variablesKey]);
  const [lang, setLang] = useState(language);
  const [wrap, setWrap] = useState(wordWrap);
  const [numbers, setNumbers] = useState(true);
  const [tab, setTab] = useState({ size: 2, spaces: true });
  // The hover tips for the language now shown: JavaScript's own, or the editor's `hover` for the language it was made for.
  const hoverFor = (current) => (current === 'javascript' ? jsHover : current === language ? (hover || []) : []);

  const host = useRef(null);
  const fileInput = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [menu, setMenu] = useState(null);
  const [status, setStatus] = useState({ line: 1, col: 1, lines: 1 });
  const [length, setLength] = useState(String(value).length);

  useImperativeHandle(ref, () => ({
    insert(text) {
      const view = viewRef.current;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
  }));

  useEffect(() => {
    const view = new EditorView({
      parent: host.current,
      doc: value,
      extensions: [
        basicSetup,
        langSlot.of(LANGUAGES[lang].load()),
        themeSlot.of(paletteTheme(palette)),
        hoverTheme,
        hoverSlot.of(hoverFor(lang)),
        tabSlot.of([EditorState.tabSize.of(tab.size), indentUnit.of(tab.spaces ? ' '.repeat(tab.size) : '\t')]),
        wrapSlot.of(wrap ? WRAP_ON : []),
        numberSlot.of([]),
        editable.of([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]),
        EditorView.contentAttributes.of({ 'aria-label': label }),
        // Text past the limit is refused rather than cut off: the editor never holds more than the server will keep.
        EditorState.transactionFilter.of((tr) => (tr.docChanged && maxLength && tr.newDoc.length > maxLength ? [] : tr)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
            setLength(update.state.doc.length);
          }
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
    viewRef.current.dispatch({ effects: hoverSlot.reconfigure(hoverFor(lang)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, jsHover, hover]);

  useEffect(() => {
    viewRef.current.dispatch({ effects: langSlot.reconfigure(LANGUAGES[lang].load()) });
  }, [lang, langSlot]);

  useEffect(() => {
    viewRef.current.dispatch({ effects: tabSlot.reconfigure([EditorState.tabSize.of(tab.size), indentUnit.of(tab.spaces ? ' '.repeat(tab.size) : '\t')]) });
  }, [tab, tabSlot]);

  useEffect(() => {
    viewRef.current.dispatch({ effects: wrapSlot.reconfigure(wrap ? WRAP_ON : []) });
  }, [wrap, wrapSlot]);

  useEffect(() => {
    viewRef.current.dispatch({ effects: numberSlot.reconfigure(numbers ? [] : NUMBERS_OFF) });
  }, [numbers, numberSlot]);

  useEffect(() => {
    const view = viewRef.current;
    if (view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      setLength(String(value).length);
    }
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
    const { ext, mime } = LANGUAGES[lang];
    const name = `${fileName.replace(/\.[^.]+$/, '')}.${ext}`;
    const url = URL.createObjectURL(new Blob([viewRef.current.state.doc.toString()], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
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
    View: [
      { label: 'Word wrap', checked: wrap, run: () => setWrap((w) => !w) },
      { label: 'Line numbers', checked: numbers, run: () => setNumbers((n) => !n) },
    ],
  };
  // The language and indentation are chosen from the bottom bar, as in VS Code.
  const statusMenus = {
    Language: languages.filter((id) => LANGUAGES[id]).map((id) => ({ label: LANGUAGES[id].label, checked: lang === id, run: () => setLang(id) })),
    Indentation: [
      ...TAB_SIZES.map((size) => ({ label: `Tab size ${size}`, checked: tab.size === size, run: () => setTab((t) => ({ ...t, size })) })),
      { label: 'Indent with spaces', checked: tab.spaces, run: () => setTab((t) => ({ ...t, spaces: true })) },
      { label: 'Indent with tabs', checked: !tab.spaces, run: () => setTab((t) => ({ ...t, spaces: false })) },
    ],
  };
  const openMenu = menu && (menus[menu.name] || statusMenus[menu.name]);

  return (
    <Box>
      <Typography variant="body2" component="span" sx={{ display: 'block', mb: 0.5, color: error ? 'error.main' : 'text.secondary' }}>{label}</Typography>
      <Box sx={{ border: 1, borderColor: error ? 'error.main' : 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.paper' }}>
        <Stack direction="row" role="toolbar" aria-label={`${label} menus`} sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover', px: 0.5 }}>
          {Object.keys(menus).map((name) => (
            <Button key={name} size="small" aria-haspopup="menu" aria-expanded={menu?.name === name ? 'true' : undefined}
              onClick={(e) => setMenu({ name, anchor: e.currentTarget })}>{name}</Button>
          ))}
          <input ref={fileInput} type="file" accept=".js,.css,.html,.htm,.txt,text/javascript,text/css,text/html,text/plain" hidden aria-label={`${label} file`} onChange={upload} />
        </Stack>
        <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={() => setMenu(null)}>
          {(openMenu || []).map((item) => (
            <MenuItem key={item.label} disabled={item.disabled} onClick={() => { setMenu(null); item.run(); }}>
              {item.checked !== undefined && <ListItemIcon sx={{ minWidth: 28 }}>{item.checked && <CheckIcon fontSize="small" />}</ListItemIcon>}
              <ListItemText>{item.label}</ListItemText>
            </MenuItem>
          ))}
        </Menu>
        <Box ref={host} sx={{
          '& .cm-editor': { maxHeight: '60vh', fontSize: 13 },
          '& .cm-editor.cm-focused': { outline: 'none' },
          '& .cm-scroller': { fontFamily: 'monospace', minHeight: 240 },
        }} />
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap
          sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover', px: 1, py: 0.25 }}>
          <Typography variant="caption" color="text.secondary">Ln {status.line}, Col {status.col}</Typography>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Typography variant="caption" color="text.secondary">{status.lines} {status.lines === 1 ? 'line' : 'lines'}</Typography>
            {maxLength && <Typography variant="caption" color="text.secondary">· {length.toLocaleString()} / {maxLength.toLocaleString()}</Typography>}
            <Button size="small" aria-haspopup="menu" sx={{ minWidth: 0, textTransform: 'none', py: 0 }}
              onClick={(e) => setMenu({ name: 'Language', anchor: e.currentTarget })}>{LANGUAGES[lang].label}</Button>
            <Button size="small" aria-haspopup="menu" sx={{ minWidth: 0, textTransform: 'none', py: 0 }}
              onClick={(e) => setMenu({ name: 'Indentation', anchor: e.currentTarget })}>
              {tab.spaces ? 'Spaces' : 'Tabs'}: {tab.size}
            </Button>
          </Stack>
        </Stack>
      </Box>
      {helperText && <FormHelperText error={error}>{helperText}</FormHelperText>}
    </Box>
  );
});

export default CodeEditor;
