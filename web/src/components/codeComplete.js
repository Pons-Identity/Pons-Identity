import { snippet } from '@codemirror/autocomplete';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { syntaxTree } from '@codemirror/language';
import { tipDom } from './codeHover.js';
import { typeTools } from './codeTypes.js';
import { GLOBALS, MEMBERS, STATICS } from './jsDocs.js';

// Code completion for the script editor. It is built from the same reference as the hover tips (see codeHover.js), so it offers
// what this server really has:
//   - script API names, as you type them or after a dot (idp. → users, groups, …), inserted as a call with its arguments;
//   - the keys of an object passed to a call: idp.users.create({ … }) offers the NewUser fields, update the UserPatch fields,
//     http.request the HttpRequest fields, and attributes: { … } the attributes defined in Settings;
//   - the fields of a value whose type can be worked out: what idp.users.find returns is a User, so `user.` offers its fields;
//   - JavaScript's own globals, statics and methods (the language package adds keywords, snippets and the script's own names).
// Types are worked out from the reference's own return types and from simple assignments, for…of loops and array callbacks in
// the script. Where that is not possible the names of methods on any value are offered instead.

const SKIPPED = /Comment|String|Regexp/;

// Splits a parameter list at the commas that are not inside braces, brackets or parentheses.
function splitTop(text) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if ('({['.includes(text[i])) depth++;
    else if (')}]'.includes(text[i])) depth--;
    else if (text[i] === ',' && depth === 0) { out.push(text.slice(from, i).trim()); from = i + 1; }
  }
  const rest = text.slice(from).trim();
  if (rest) out.push(rest);
  return out;
}

const argsOf = (sig) => {
  const open = sig.indexOf('(');
  return open < 0 ? null : sig.slice(open + 1, sig.lastIndexOf(')')).trim();
};

// The text to insert for a function, with placeholders for what the caller fills in. `name` is the last part of the dotted name.
function callSnippet(name, sig, types) {
  const args = argsOf(sig);
  if (args === null) return name;
  if (!args) return `${name}()`;
  if (args.startsWith('{')) return `${name}(${args.includes(':') ? args.replace(/:\s*value\b/g, ': ${}') : '{ ${} }'})`;
  const parts = splitTop(args).filter((p) => !p.endsWith('?')).map((p, i) => {
    if (types.has(p) || p.startsWith('{')) return '{ ${} }';
    return /^[A-Za-z_$][\w$]*$/.test(p) ? `\${${i + 1}:${p}}` : '${}';
  });
  return `${name}(${parts.join(', ')})`;
}

const note = (text) => () => { const d = document.createElement('div'); d.className = 'cm-doc-tip'; d.textContent = text; return d; };

// A short phrase for the right of a suggestion: what a function returns.
const brief = (returns) => (returns || '').split(/[.,(]/)[0].trim().slice(0, 28);

/**
 * The completion source. `docs` is the Map from buildReferenceDocs, `reference` the server's reference (for its types and
 * defined attributes) and `variables` the names the Inputs table makes available to the script.
 */
export function completionSource({ docs, reference, variables = [] }) {
  const { types, refType, primitive, typeOf } = typeTools(docs, reference);
  const defined = reference?.attributes?.defined || [];

  // What lies directly under a dotted name in the script API: Map from the next word to { entry, below }.
  function childrenOf(prefix) {
    const found = new Map();
    for (const [key, entry] of docs) {
      if (prefix && !key.startsWith(`${prefix}.`)) continue;
      const rest = prefix ? key.slice(prefix.length + 1) : key;
      const word = rest.split('.')[0];
      if (word === 'NAME' || word === 'return') continue;
      const item = found.get(word) || { entry: null, below: false };
      if (rest === word) item.entry = entry; else item.below = true;
      found.set(word, item);
    }
    return found;
  }

  const apiOptions = (prefix) => [...childrenOf(prefix)].map(([word, { entry, below }]) => {
    const callable = entry && entry.sig.includes('(');
    return {
      label: word,
      type: below && !callable ? 'namespace' : callable ? 'function' : 'property',
      detail: entry ? brief(entry.returns) : undefined,
      info: entry ? () => tipDom(entry) : undefined,
      apply: callable ? snippet(callSnippet(word, entry.sig, types)) : undefined,
      boost: 1,
    };
  });

  const fieldOptions = (type) => types.get(type)?.fields.map((f) => ({
    label: f.name, type: 'property', detail: f.type, info: f.description ? note(f.description) : undefined, boost: f.required ? 2 : 0,
  })) || [];

  // Methods that fit a kind of value ('array', 'string', 'number'), or all of them when the kind is not known.
  function methodOptions(kind) {
    const options = [];
    for (const [name, entries] of Object.entries(MEMBERS)) {
      const fits = !kind || entries.some((m) => m.sig.startsWith(`${kind}.`) || m.sig.startsWith('value.') || (kind === 'string' && /^(regex|value)\./.test(m.sig)));
      if (!fits) continue;
      options.push({
        label: name, type: entries[0].sig.startsWith('value.') && !entries[0].sig.includes('(') ? 'property' : 'method',
        detail: brief(entries[0].returns), info: () => { const d = document.createElement('div'); entries.forEach((m) => d.appendChild(tipDom(m))); return d; },
      });
    }
    return options;
  }

  // If the cursor is where a key of an object literal goes, the keys that fit: { fields, taken } or null.
  function keyContext(state, from) {
    const node = syntaxTree(state).resolveInner(from, 0);
    if (node.name !== 'ObjectExpression') return null;
    // A key follows "{" or ",", never ":".
    if (!/[{,]\s*$/.test(state.sliceDoc(Math.max(0, from - 200), from))) return null;
    const taken = new Set();
    for (let c = node.firstChild; c; c = c.nextSibling) {
      const key = c.name === 'Property' ? c.firstChild : c.name === 'PropertyDefinition' ? c : null;
      if (key && key.from !== from) taken.add(state.sliceDoc(key.from, key.to));
    }
    const parent = node.parent;
    if (parent?.name === 'Property') {
      const key = parent.firstChild;
      if (key && state.sliceDoc(key.from, key.to) === 'attributes' && defined.length) {
        return { taken, options: defined.map((a) => ({ label: a.name, type: 'property', detail: a.type === 'enum' ? a.options.join(' | ') : a.type, info: note(`${a.label !== a.name ? `${a.label}. ` : ''}Example: ${JSON.stringify(a.example)}${a.required ? '. Required.' : ''}`), apply: `${a.name}: `, boost: a.required ? 2 : 0 })) };
      }
      return null;
    }
    if (parent?.name !== 'ArgList' || parent.parent?.name !== 'CallExpression') return null;
    const callee = parent.parent.firstChild;
    const path = state.sliceDoc(callee.from, callee.to).replace(/\?\./g, '.').replace(/\s+/g, '');
    const entry = docs.get(path);
    const args = entry && argsOf(entry.sig);
    if (!args) return null;
    let index = 0;
    for (let c = parent.firstChild; c; c = c.nextSibling) if (c.from < node.from && !['(', ',', 'LineComment', 'BlockComment'].includes(c.name)) index++;
    const wanted = splitTop(args)[index]?.replace(/\?$/, '');
    if (!wanted || !types.has(wanted)) return null;
    return { taken, options: types.get(wanted).fields.map((f) => ({
      label: f.name, type: 'property', detail: f.type, info: f.description ? note(f.description) : undefined, apply: `${f.name}: `, boost: f.required ? 2 : 0,
    })) };
  }

  return function complete(context) {
    const { state, pos } = context;
    if (SKIPPED.test(syntaxTree(state).resolveInner(pos, -1).name)) return null;
    const word = context.matchBefore(/[\w$]*/);
    const line = state.doc.lineAt(word.from);
    const before = state.sliceDoc(line.from, word.from);
    const validFor = /^[\w$]*$/;

    // After a dot: a name from the script API, a static, a field of a typed value, or a method.
    const dot = /(?:^|[^\w$.])((?:[A-Za-z_$][\w$]*\??\.)*[A-Za-z_$][\w$]*)\??\.$/.exec(before);
    const afterCall = /([A-Za-z_$][\w$.]*)\s*\([^()]*\)\??\.$/.exec(before);
    if (dot || afterCall) {
      const text = state.sliceDoc(0, pos);
      if (dot) {
        const path = dot[1].replace(/\?\./g, '.');
        const api = apiOptions(path);
        if (api.length) return { from: word.from, options: api, validFor };
        const statics = Object.entries(STATICS).filter(([k]) => k.startsWith(`${path}.`)).map(([k, v]) => ({
          label: k.slice(path.length + 1), type: v.sig.includes('(') ? 'function' : 'constant', detail: brief(v.returns), info: () => tipDom(v),
          apply: v.sig.includes('(') ? snippet(callSnippet(k.slice(path.length + 1), v.sig, types)) : undefined,
        }));
        if (statics.length) return { from: word.from, options: statics, validFor };
      }
      const t = dot ? typeOf(dot[1].replace(/\?\./g, '.'), false, text, 0) : typeOf(afterCall[1].replace(/\?\./g, '.'), true, text, 0);
      if (t) return { from: word.from, options: t.kind ? methodOptions(t.kind) : t.array ? methodOptions('array') : fieldOptions(t.name), validFor };
      return { from: word.from, options: methodOptions(), validFor };
    }

    // Where the key of an object passed to a call goes.
    if (word.text || context.explicit) {
      const keys = keyContext(state, word.from);
      if (keys) return { from: word.from, options: keys.options.filter((o) => !keys.taken.has(o.label)), validFor };
    }

    // A plain word: the script API's first words, the Inputs table's variables and JavaScript's globals.
    if (!word.text && !context.explicit) return null;
    const names = new Set();
    const options = [];
    const add = (o) => { if (!names.has(o.label)) { names.add(o.label); options.push(o); } };
    apiOptions('').forEach(add);
    variables.forEach((v) => add({ label: v, type: 'variable', detail: 'input', boost: 2 }));
    for (const [name, g] of Object.entries(GLOBALS)) {
      add({ label: name, type: /^[A-Z]/.test(name) ? 'class' : 'function', detail: brief(g.returns), info: () => tipDom(g) });
    }
    return { from: word.from, options, validFor };
  };
}

/** The extension that adds the completion source to JavaScript. */
export const codeCompletion = (config) => javascriptLanguage.data.of({ autocomplete: completionSource(config) });
