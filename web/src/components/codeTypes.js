// Working out the type of a name in a script, for completions and hover tips. A type is { name, array } for one of the reference's
// types (User, HttpResponse, …), or { name: null, array: false, kind } for a plain value that has methods but no fields of its own.
// Nothing here runs the script: types come from the reference's own return types, and from simple assignments, for…of loops and
// array callbacks that name the variable.

const TYPE_AT_START = /^\s*([A-Z]\w*)(\[\])?/;
const ARRAY_ELEMENT = new Set(['find', 'findLast', 'at', 'pop', 'shift']);
const ARRAY_SAME = new Set(['filter', 'slice', 'sort', 'reverse', 'concat']);
const CALLBACKS = 'map|filter|find|findLast|findIndex|some|every|forEach|flatMap|sort';
const escapeRe = (s) => s.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');

/** `docs` is the Map from buildReferenceDocs and `reference` the server's reference. */
export function typeTools(docs, reference) {
  const types = new Map((reference?.types || []).map((t) => [t.name, t]));

  const refType = (text) => {
    const m = TYPE_AT_START.exec(text || '');
    return m && types.has(m[1]) ? { name: m[1], array: Boolean(m[2]) } : null;
  };

  // A field of a plain type such as string or number: no fields of its own, but methods that fit.
  const primitive = (text) => {
    const kind = /^string\[\]|\[\]$/.test(text || '') ? 'array' : /^(string|number)\b/.exec(text || '')?.[1];
    return kind ? { name: null, array: false, kind } : null;
  };

  // The type of a dotted name in the script, or of what it returns when `call` is true. { name, array } or null.
  function typeOf(path, call, text, depth) {
    if (depth > 5) return null;
    if (call) {
      const t = refType(docs.get(path)?.returns);
      if (t) return t;
      const dot = path.lastIndexOf('.');
      const base = dot > 0 ? typeOf(path.slice(0, dot), false, text, depth + 1) : null;
      const method = path.slice(dot + 1);
      if (base?.array && ARRAY_ELEMENT.has(method)) return { name: base.name, array: false };
      if (base?.array && ARRAY_SAME.has(method)) return base;
      return null;
    }
    const [root, ...rest] = path.split('.');
    let t = root === 'trigger' && types.has('Trigger') ? { name: 'Trigger', array: false } : variableType(root, text, depth + 1);
    for (const key of rest) {
      if (!t || t.array || !t.name) return null;
      const field = types.get(t.name).fields.find((f) => f.name === key);
      t = field ? refType(field.type) || primitive(field.type) : null;
    }
    return t;
  }

  // The type of a variable, from the last place before the cursor that gives it a value.
  function variableType(name, text, depth) {
    const id = escapeRe(name);
    const forms = [
      { re: new RegExp(`(?<![\\w$.])(?:(?:const|let|var)\\s+)?${id}\\s*=(?![=>])\\s*(?:await\\s+)?([\\w$.]+)(?![\\w$.])\\s*(\\()?(?!\\s*\\[)`, 'g'), element: false },
      { re: new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${id}\\s+of\\s+(?:await\\s+)?([\\w$.]+)(?![\\w$.])\\s*(\\()?(?!\\s*\\[)`, 'g'), element: true },
      { re: new RegExp(`([\\w$.]+)\\.(?:${CALLBACKS})\\(\\s*(?:async\\s*)?\\(?\\s*${id}\\b`, 'g'), element: true },
    ];
    let latest = null;
    for (const form of forms) {
      for (const m of text.matchAll(form.re)) if (!latest || m.index > latest.index) latest = { index: m.index, m, element: form.element };
    }
    if (!latest) return null;
    const t = typeOf(latest.m[1], Boolean(latest.m[2]), text, depth);
    if (!t) return null;
    if (!latest.element) return t;
    return t.array ? { name: t.name, array: false } : null;
  }

  return { types, refType, primitive, typeOf, variableType };
}
