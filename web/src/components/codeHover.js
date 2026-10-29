import { hoverTooltip, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { describeLocal } from './codeLocals.js';
import { typeTools } from './codeTypes.js';
import { GLOBALS, KEYWORDS, MEMBERS, STATICS } from './jsDocs.js';

// Hover documentation for the code editor, in the manner of VS Code: hold the pointer over a name and a tip shows what it is,
// what it takes, what it returns and an example. The names of the script API come from the server's reference (so they are the
// ones this server really has, including the administrator's own fn.* functions); the rest of JavaScript is in jsDocs.js.

const IDENT = /[\w$]/;
const PATH_LIMIT = 12;

// "await http.put(url, body), http.patch(url, body)" is several signatures that share one description.
const splitSignatures = (signature) => signature.split(/,\s+(?=(?:await\s+)?[A-Za-z_$][\w$.]*\()/);
const nameOf = (signature) => /^(?:await\s+)?([A-Za-z_$][\w$.]*)/.exec(signature)?.[1];

/**
 * The lookup built from the server's reference ({ variables, functions }): a Map from a dotted name such as "idp.users.find" to
 * { sig, desc, returns, throws, example, scope }. Returns an empty Map when there is no reference yet.
 */
export function buildReferenceDocs(reference) {
  const docs = new Map();
  if (!reference) return docs;
  for (const v of reference.variables || []) {
    docs.set(v.name, { sig: v.name, desc: v.description, example: v.example });
  }
  for (const group of reference.functions || []) {
    for (const item of group.items) {
      for (const signature of splitSignatures(item.signature)) {
        const name = nameOf(signature);
        if (!name || docs.has(name)) continue;
        docs.set(name, { sig: signature.trim(), desc: item.description, returns: item.returns, throws: item.throws, example: item.example, scope: group.scope });
      }
    }
  }
  addUserFunctions(docs, reference);
  // console.log and the others are the log levels under other names.
  const levels = { log: 'log', info: 'log', debug: 'log.debug', warn: 'log.warning', error: 'log.error' };
  for (const [alias, target] of Object.entries(levels)) {
    if (docs.has(target) && !docs.has(`console.${alias}`)) docs.set(`console.${alias}`, { ...docs.get(target), sig: `console.${alias}(...values)` });
  }
  return docs;
}

// Where a function's own page is, for the link in its tip. The console's routes are the same in every deployment.
const FUNCTION_PAGE = '/admin/integrations/functions/';

// The leading comment of a function's body is its docstring: it is moved above a stand-in declaration so it is read like a JSDoc.
const LEADING_COMMENT = /^\s*((?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))+)/;

// Each of the administrator's functions (fn.NAME), described from its Inputs table, its docstring and its code: what each input
// is, what it returns and what it throws. The body is read as the body of a stand-in `async function`, the way the server runs it.
function addUserFunctions(docs, reference) {
  const tools = typeTools(docs, reference);
  const ctx = { docs, tools, reference, variables: [] };
  const catalog = new Map((reference.inputs || []).map((i) => [i.name, i.description]));
  const userType = new Map((tools.types.get('User')?.fields || []).map((f) => [f.name, f]));
  for (const group of reference.functions || []) {
    for (const item of group.items) {
      const f = item.fn;
      if (!f) continue;
      const key = `fn.${f.name}`;
      const base = docs.get(key);
      try {
        const lead = LEADING_COMMENT.exec(f.script || '');
        const body = lead ? f.script.slice(lead[0].length) : f.script || '';
        const names = f.inputs.map((i) => i.variable || i.name).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
        const doc = `${lead ? lead[1].trimEnd() : ''}\nasync function ${f.name}(${names.join(', ')}) {\n${body}\n}\n`;
        const state = EditorState.create({ doc, extensions: [javascriptLanguage] });
        const found = describeLocal(state, doc.indexOf(`function ${f.name}`) + 9, f.name, ctx);
        if (!found) continue;
        const byVariable = new Map((found.params || []).map((p) => [p.name, p]));
        const params = f.inputs.map((i) => {
          const variable = i.variable || i.name;
          const p = byVariable.get(variable) || {};
          const known = userType.get(i.name);
          return {
            name: variable === i.name ? i.name : `${i.name} (read as ${variable})`,
            type: p.type || (known && /^string|number|boolean/.test(known.type) ? known.type : ''),
            desc: p.desc || catalog.get(i.name) || known?.description || '',
          };
        });
        // Called with await, so the promise is not part of what the caller sees.
        const returns = (found.returns || '').replace(/,? ?as a promise: use await/, '').replace(/^a promise: use await$/, 'a value (its type is not known from the code)');
        docs.set(key, {
          ...base, sig: base?.sig || `await ${key}()`, desc: found.desc || f.description || 'No description.',
          params: params.length ? params : undefined, input: params.length ? undefined : 'none',
          returns, throws: found.throws || undefined, example: found.example || base?.example,
          link: `${FUNCTION_PAGE}${encodeURIComponent(f.name)}`, linkText: `Open fn.${f.name} in a new tab`,
          scope: undefined, from: undefined,
        });
      } catch { /* the plain description stays */ }
    }
  }
}

// The dotted name the pointer is over: everything from the start of the chain up to the end of the hovered word.
// Returns { from, to, path } or null when the pointer is not on a name.
function pathAt(view, pos) {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  let start = pos - line.from;
  let end = start;
  while (start > 0 && IDENT.test(text[start - 1])) start--;
  while (end < text.length && IDENT.test(text[end])) end++;
  if (start === end || /\d/.test(text[start])) return null;
  const wordEnd = end;
  let from = start;
  // Walk back over "a.b." and "a?.b." to the start of the chain.
  for (;;) {
    let dot = from;
    if (text[dot - 1] === '.') dot -= text[dot - 2] === '?' ? 2 : 1;
    else break;
    let head = dot;
    while (head > 0 && IDENT.test(text[head - 1])) head--;
    if (head === dot) break;
    from = head;
  }
  return { from: line.from + start, to: line.from + wordEnd, path: text.slice(from, wordEnd).replace(/\?\./g, '.') };
}

const section = (parent, label, text) => {
  if (!text) return;
  const row = parent.appendChild(document.createElement('div'));
  row.className = 'cm-doc-row';
  const strong = row.appendChild(document.createElement('strong'));
  strong.textContent = `${label} `;
  row.append(text);
};

// One entry as a tip. Everything goes in as text, never as markup.
export function tipDom(entry, extra) {
  const dom = document.createElement('div');
  dom.className = 'cm-doc-tip';
  const sig = dom.appendChild(document.createElement('div'));
  sig.className = 'cm-doc-sig';
  sig.textContent = entry.sig;
  if (entry.desc) {
    const d = dom.appendChild(document.createElement('div'));
    d.className = 'cm-doc-desc';
    d.textContent = entry.desc;
  }
  section(dom, 'Assigned from', entry.from);
  section(dom, 'Type', entry.type);
  section(dom, 'Input', entry.input);
  if (entry.params) {
    const heading = dom.appendChild(document.createElement('div'));
    heading.className = 'cm-doc-label';
    heading.textContent = 'Inputs';
    const list = dom.appendChild(document.createElement('ul'));
    list.className = 'cm-doc-list cm-doc-params';
    entry.params.forEach((p) => { list.appendChild(document.createElement('li')).textContent = `${p.name}${p.type ? `: ${p.type}` : ''}${p.desc ? ` — ${p.desc}` : ''}`; });
  }
  section(dom, 'Fields', entry.fields);
  section(dom, 'Returns', entry.returns);
  section(dom, 'Throws', entry.throws);
  section(dom, 'Needs scope', entry.scope);
  section(dom, 'Note', entry.note);
  section(dom, 'From other languages', entry.coming);
  if (entry.example) {
    const label = dom.appendChild(document.createElement('div'));
    label.className = 'cm-doc-label';
    label.textContent = 'Example';
    const pre = dom.appendChild(document.createElement('pre'));
    pre.textContent = entry.example;
  }
  if (entry.link) {
    const a = dom.appendChild(document.createElement('a'));
    a.className = 'cm-doc-link';
    a.href = entry.link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${entry.linkText || 'Open definition'} ↗`;
  }
  if (extra) dom.appendChild(extra);
  return dom;
}

const listing = (title, entries) => {
  const dom = document.createElement('div');
  dom.className = 'cm-doc-tip';
  const head = dom.appendChild(document.createElement('div'));
  head.className = 'cm-doc-sig';
  head.textContent = title;
  const ul = dom.appendChild(document.createElement('ul'));
  ul.className = 'cm-doc-list';
  entries.slice(0, PATH_LIMIT).forEach((x) => { ul.appendChild(document.createElement('li')).textContent = x.sig; });
  if (entries.length > PATH_LIMIT) ul.appendChild(document.createElement('li')).textContent = `…and ${entries.length - PATH_LIMIT} more`;
  return dom;
};

// What a dotted name means, as the list of DOM nodes to show, or null. `ref` is the Map from buildReferenceDocs. `shadowed` is true
// when the script declares the first word itself, so only methods of values can apply.
export function lookup(path, ref, shadowed = false) {
  const parts = path.split('.');
  const last = parts[parts.length - 1];
  if (!shadowed) {
    // Own properties only, so a word such as "constructor" is not mistaken for an entry.
    const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : null);
    if (path === 'return' && ref.has(path)) return [tipDom(KEYWORDS.return), tipDom(ref.get(path))];
    if (ref.has(path)) return [tipDom(ref.get(path))];
    const fixed = own(STATICS, path) || (parts.length === 1 ? own(KEYWORDS, path) || own(GLOBALS, path) : null);
    if (fixed) return [tipDom(fixed)];
    // A namespace such as idp.users or http: list what it holds.
    const prefix = `${path}.`;
    const inside = [...ref.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    if (inside.length) return [listing(path, inside)];
    // Any fn.NAME not listed (a function added since the page loaded) gets the general description.
    if (parts[0] === 'fn' && parts.length === 2 && ref.has('fn.NAME')) return [tipDom(ref.get('fn.NAME'))];
  }
  // A method on a value of unknown type.
  if (parts.length > 1 && Object.hasOwn(MEMBERS, last)) return MEMBERS[last].map((m) => tipDom(m));
  return null;
}

const SKIPPED = /Comment|String|Regexp/;
const NAMES = new Set(['VariableName', 'VariableDefinition', 'PropertyDefinition']);

// The tip for a field of a value whose type is known: user.email, response.status, trigger.type.
function fieldTip(tools, path, text) {
  const dot = path.lastIndexOf('.');
  const owner = dot > 0 ? tools.typeOf(path.slice(0, dot), false, text, 0) : null;
  if (!owner?.name || owner.array) return null;
  const field = tools.types.get(owner.name).fields.find((f) => f.name === path.slice(dot + 1));
  return field ? { sig: `${path.slice(dot + 1)}: ${field.type}`, desc: field.description, type: `a field of ${owner.name}` } : null;
}

// The fields of a shape written like "{ end_sessions, notify_user: boolean, groups: string[] }" in a function's Returns.
function shapeFields(shape) {
  const end = shape.indexOf('}');
  if (!shape.startsWith('{') || end < 0) return [];
  return shape.slice(1, end).split(',').map((part) => {
    const [name, type] = part.split(':').map((x) => x.trim());
    return { name, type: type || '' };
  }).filter((f) => /^[A-Za-z_$][\w$]*$/.test(f.name));
}

// Tips for a property of an object that is not a reference type: a key of what a function returned, or of input, vars, integration.
function propertyTip(path, local, ref, variables) {
  const [root, key] = path.split('.');
  if (path.split('.').length !== 2) return null;
  if (local?.shape) {
    const f = shapeFields(local.shape).find((x) => x.name === key);
    return f ? { sig: `${path}${f.type ? `: ${f.type}` : ''}`, desc: `A field of what ${local.from ? local.from.replace(/\(.*$/, '') : 'the function'} returned.`, type: f.type || undefined } : null;
  }
  if (local || variables.includes(root) || !ref.has(root)) return null;
  if (root === 'vars') return { sig: path, desc: `Your variable ${key}, from Integrations → Variables. A variable marked secret is read the same way, but its value is hidden from logs, output and results.` };
  if (root === 'input') return { sig: path, desc: `The value the run was given for ${key}: typed into Run, sent in a webhook body, or provided by the schedule or event. It is undefined if the caller left it out.` };
  if (root === 'integration') return { sig: path, desc: key === 'id' ? 'The integration\'s ID number.' : key === 'name' ? 'The integration\'s name.' : '' };
  return null;
}

/**
 * The hover extension, given the Map from buildReferenceDocs. `reference` is the server's reference (for its types) and
 * `variables` the names the Inputs table gives the script. Tips appear after 0.3 seconds and fade in.
 */
export function codeHover(ref, options = {}) {
  return hoverTooltip(hoverSource(ref, options), { hoverTime: 300 });
}

/** What codeHover asks at a position: (view, pos) => { pos, end, create } or null. Apart from the extension so it can be tested. */
export function hoverSource(ref, { reference, variables = [] } = {}) {
  const tools = typeTools(ref, reference);
  const ctx = { docs: ref, tools, reference, variables };
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (view, pos) => {
    const node = syntaxTree(view.state).resolveInner(pos, 1);
    if (SKIPPED.test(node.name)) return null;
    const at = pathAt(view, pos);
    if (!at) return null;
    const parts = at.path.split('.');
    let doms = null;
    let local = null;
    // A name the script declares itself, or the first word of a chain that starts with one.
    if (NAMES.has(node.name) || parts.length > 1) {
      local = describeLocal(view.state, pos, parts[0], ctx);
      if (parts.length === 1 && local) doms = [tipDom(local)];
      if (parts.length === 1 && !local && variables.includes(parts[0])) {
        doms = [tipDom({ sig: `input ${parts[0]}`, desc: 'A variable from this script\'s Inputs table. It holds the value the caller passes in for it each run.' })];
      }
    }
    if (!doms && parts.length > 1) {
      const field = fieldTip(tools, at.path, view.state.sliceDoc(0, pos));
      if (field) doms = [tipDom(field)];
    }
    if (!doms && parts.length === 2) {
      const prop = propertyTip(at.path, local, ref, variables);
      if (prop) doms = [tipDom(prop)];
    }
    if (!doms) doms = lookup(at.path, ref, Boolean(local) || (parts.length > 1 && variables.includes(parts[0])));
    if (!doms) return null;
    return {
      pos: at.from, end: at.to, above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-doc-stack';
        doms.forEach((d) => dom.appendChild(d));
        if (!reduced()) dom.style.opacity = '0';
        return {
          dom,
          // Faded in once it is on the page. Reading offsetWidth makes the browser notice the opacity of 0 first, so it animates.
          mount() {
            if (!reduced()) {
              void dom.offsetWidth;
              dom.style.transition = 'opacity 200ms ease-out';
              dom.style.opacity = '1';
            }
          },
        };
      },
    };
  };
}

// The structure of a tip. Colors come from paletteTheme in CodeEditor, which follows the page's light or dark palette.
export const hoverTheme = EditorView.baseTheme({
  '.cm-doc-stack': { maxWidth: 'min(560px, 80vw)', maxHeight: '320px', overflowY: 'auto', fontFamily: 'system-ui, sans-serif', fontSize: '12.5px', lineHeight: 1.45 },
  '.cm-doc-tip': { padding: '8px 10px' },
  '.cm-doc-tip + .cm-doc-tip': { borderTop: '1px solid rgba(128,128,128,0.35)' },
  '.cm-doc-sig': { fontFamily: 'monospace', fontWeight: 600, wordBreak: 'break-word', marginBottom: '4px' },
  '.cm-doc-row': { marginTop: '3px', wordBreak: 'break-word' },
  '.cm-doc-label': { marginTop: '6px', fontWeight: 600, opacity: 0.7 },
  '.cm-doc-tip pre': { margin: '2px 0 0', padding: '6px 8px', borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', backgroundColor: 'rgba(128,128,128,0.15)' },
  '.cm-doc-link': { display: 'inline-block', marginTop: '6px', color: 'inherit', textDecoration: 'underline' },
  '.cm-doc-list': { margin: '2px 0 0', paddingLeft: '18px', fontFamily: 'monospace', fontSize: '12px' },
  '.cm-doc-params': { fontFamily: 'inherit', fontSize: '12.5px' },
});
