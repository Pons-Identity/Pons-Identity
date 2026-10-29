// Attribute transformation rules: one `target = expression` per line, e.g.
//
//   mail = lower(mail)
//   upn = concat(username, "@example.com")
//   department = replace(department, "^Eng", "Engineering")
//
// Expressions are string literals, numbers, attribute references (a SAML attribute name already produced by the
// mappings, else an IdP attribute such as `email` or `custom:badge`) and function calls. Every value is a list
// of strings; most functions apply to each value. An empty result removes the attribute. Nothing is eval'd.

const MAX_INPUT = 2000;
const MAX_PATTERN = 200;

// name -> { min, max args, regex: index of a pattern argument to validate at parse time }
const FUNCTIONS = {
  lower: { min: 1, max: 1 },
  upper: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  first: { min: 1, max: 1 },
  join: { min: 2, max: 2 },
  concat: { min: 1, max: Infinity },
  coalesce: { min: 1, max: Infinity },
  replace: { min: 3, max: 3, regex: 1 },
  extract: { min: 2, max: 3, regex: 1 },
  substring: { min: 2, max: 3 },
  split: { min: 3, max: 3 },
  attr: { min: 1, max: 1 },
  drop: { min: 0, max: 0 },
};

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let out = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Error('unterminated string');
        const ch = src[i++];
        if (ch === '"') break;
        if (ch === '\\' && i < src.length) {
          const n = src[i++];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' || n === '\\' ? n : `\\${n}`; // keep \d etc. for regexes
        } else out += ch;
      }
      toks.push({ t: 'str', v: out });
    } else if ('(),='.includes(c)) {
      toks.push({ t: c });
      i++;
    } else if (/[0-9-]/.test(c) && /^-?\d+(?![\w.:/-])/.test(src.slice(i))) {
      const m = /^-?\d+/.exec(src.slice(i))[0];
      toks.push({ t: 'num', v: Number(m) });
      i += m.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(src.slice(i))[0];
      toks.push({ t: 'id', v: m });
      i += m.length;
    } else {
      throw new Error(`unexpected "${c}"`);
    }
  }
  return toks;
}

function parseExpr(toks, pos) {
  const tok = toks[pos.i++];
  if (!tok) throw new Error('expression expected');
  if (tok.t === 'str') return { k: 'lit', v: tok.v };
  if (tok.t === 'num') return { k: 'num', v: tok.v };
  if (tok.t !== 'id') throw new Error('expression expected');
  if (toks[pos.i]?.t !== '(') return { k: 'ref', name: tok.v };

  pos.i++;
  const fn = FUNCTIONS[tok.v];
  if (!fn) throw new Error(`unknown function "${tok.v}"`);
  const args = [];
  if (toks[pos.i]?.t === ')') pos.i++;
  else {
    for (;;) {
      args.push(parseExpr(toks, pos));
      const n = toks[pos.i++];
      if (n?.t === ')') break;
      if (n?.t !== ',') throw new Error(`expected "," or ")" in ${tok.v}()`);
    }
  }
  if (args.length < fn.min || args.length > fn.max) {
    throw new Error(`${tok.v}() takes ${fn.min === fn.max ? fn.min : `${fn.min}${fn.max === Infinity ? '+' : `-${fn.max}`}`} argument(s)`);
  }
  const rx = fn.regex !== undefined && args[fn.regex];
  if (rx && rx.k === 'lit') compile(rx.v);
  return { k: 'call', fn: tok.v, args };
}

function compile(pattern) {
  if (pattern.length > MAX_PATTERN) throw new Error(`pattern is longer than ${MAX_PATTERN} characters`);
  try {
    return new RegExp(pattern, 'g');
  } catch {
    throw new Error(`invalid regular expression "${pattern}"`);
  }
}

// -> { rules: [{ line, target, expr }], errors: ['Line 3: ...'] }
function parseRules(text) {
  const rules = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      const toks = tokenize(line);
      if (!['id', 'str'].includes(toks[0]?.t) || toks[1]?.t !== '=') throw new Error('expected "attribute = expression"');
      const pos = { i: 2 };
      const expr = parseExpr(toks, pos);
      if (pos.i < toks.length) throw new Error('unexpected text after the expression');
      rules.push({ line: idx + 1, target: toks[0].v, expr });
    } catch (e) {
      errors.push(`Line ${idx + 1}: ${e.message}`);
    }
  });
  return { rules, errors };
}

const num = (v, name) => {
  if (typeof v !== 'number') throw new Error(`${name}() needs a number`);
  return v;
};

function evaluate(node, env) {
  if (node.k === 'lit') return [node.v];
  if (node.k === 'num') return node.v;
  if (node.k === 'ref') return env.lookup(node.name);

  const raw = node.args.map((a) => evaluate(a, env));
  const vals = (i) => {
    const v = raw[i];
    return Array.isArray(v) ? v : [String(v)];
  };
  const one = (i) => vals(i)[0] ?? '';
  const lit = (i) => String(one(i));
  const each = (f) => vals(0).map((v) => f(String(v).slice(0, MAX_INPUT)));

  switch (node.fn) {
    case 'lower': return each((v) => v.toLowerCase());
    case 'upper': return each((v) => v.toUpperCase());
    case 'trim': return each((v) => v.trim());
    case 'first': return vals(0).slice(0, 1);
    case 'join': return vals(0).length ? [vals(0).join(lit(1))] : [];
    case 'concat': {
      const parts = raw.map((_, i) => one(i));
      return parts.every((p) => p === '') ? [] : [parts.join('')];
    }
    case 'coalesce': return raw.map((_, i) => vals(i)).find((v) => v.length && v.some((x) => x !== '')) || [];
    case 'replace': {
      const re = compile(lit(1));
      return each((v) => v.replace(re, lit(2)));
    }
    case 'extract': {
      const re = compile(lit(1));
      const group = raw[2] === undefined ? 1 : num(raw[2], 'extract');
      return each((v) => {
        re.lastIndex = 0;
        const m = re.exec(v);
        return m && m[group] !== undefined ? m[group] : null;
      }).filter((v) => v !== null);
    }
    case 'substring': {
      const start = num(raw[1], 'substring');
      const len = raw[2] === undefined ? undefined : num(raw[2], 'substring');
      return each((v) => (len === undefined ? v.slice(start) : v.substr(start, len)));
    }
    case 'split': {
      const sep = lit(1);
      const index = num(raw[2], 'split');
      return each((v) => {
        const parts = v.split(sep);
        return parts.at(index) ?? null;
      }).filter((v) => v !== null);
    }
    case 'attr': return env.lookup(lit(0));
    case 'drop': return [];
    default: throw new Error(`unknown function "${node.fn}"`);
  }
}

/**
 * Apply parsed rules to attrs (Map of SAML name -> values), in order. Mutates attrs.
 * resolveIdp(key) returns the values of an IdP attribute. Returns the runtime errors, one per failing rule.
 */
function applyRules(rules, attrs, resolveIdp) {
  const errors = [];
  const env = { lookup: (name) => (attrs.has(name) ? [...attrs.get(name)] : resolveIdp(name)) };
  for (const r of rules) {
    try {
      const out = evaluate(r.expr, env);
      const values = (Array.isArray(out) ? out : [String(out)]).map(String).filter((v) => v !== '');
      if (values.length) attrs.set(r.target, [...new Set(values)]);
      else attrs.delete(r.target);
    } catch (e) {
      errors.push(`Line ${r.line}: ${e.message}`);
    }
  }
  return errors;
}

module.exports = { parseRules, applyRules, FUNCTIONS };
