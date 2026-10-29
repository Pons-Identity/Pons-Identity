// RFC 4515 search filters, the syntax directory searches use: (&(department=Underwater Basket-Weaving)(mail=*)).
// Used to search the people in this IdP with the same filters an administrator would write for LDAP.

const MAX_LENGTH = 512;
const MAX_DEPTH = 10;

class LdapFilterError extends Error {}

const fail = (message) => { throw new LdapFilterError(message); };

// Escapes are \XX (two hex digits) and stand for bytes, so a multi-byte character can be written as several of them.
function unescape(raw) {
  const parts = [];
  let plain = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') {
      plain += raw[i];
      continue;
    }
    if (plain) parts.push(Buffer.from(plain, 'utf8'));
    plain = '';
    parts.push(Buffer.from([parseInt(raw.slice(i + 1, i + 3), 16)]));
    i += 2;
  }
  if (plain) parts.push(Buffer.from(plain, 'utf8'));
  return Buffer.concat(parts).toString('utf8');
}

/** Turns filter text into a tree: { op: 'and'|'or', kids } | { op: 'not', kid } | { op: 'present'|'eq'|'approx'|'ge'|'le'|'sub', attr, ... }. */
function parse(text) {
  if (text.length > MAX_LENGTH) fail(`The filter is longer than ${MAX_LENGTH} characters.`);
  let i = 0;
  const at = () => text[i];

  function expect(ch) {
    if (text[i] !== ch) fail(`Expected "${ch}" at position ${i + 1}.`);
    i += 1;
  }

  function filter(depth) {
    if (depth > MAX_DEPTH) fail(`The filter is nested more than ${MAX_DEPTH} levels deep.`);
    expect('(');
    let node;
    if (at() === '&' || at() === '|') {
      const op = at() === '&' ? 'and' : 'or';
      i += 1;
      const kids = [];
      while (at() === '(') kids.push(filter(depth + 1));
      if (!kids.length) fail(`A "${op === 'and' ? '&' : '|'}" group needs at least one condition.`);
      node = { op, kids };
    } else if (at() === '!') {
      i += 1;
      node = { op: 'not', kid: filter(depth + 1) };
    } else {
      node = item();
    }
    expect(')');
    return node;
  }

  function item() {
    const name = /[A-Za-z][A-Za-z0-9-]*/y;
    name.lastIndex = i;
    const m = name.exec(text);
    if (!m) fail(`Expected an attribute name at position ${i + 1}.`);
    i = name.lastIndex;
    const attr = m[0];

    let op;
    if (text.startsWith('>=', i)) { op = 'ge'; i += 2; }
    else if (text.startsWith('<=', i)) { op = 'le'; i += 2; }
    else if (text.startsWith('~=', i)) { op = 'approx'; i += 2; }
    else if (at() === '=') { op = 'eq'; i += 1; }
    else fail(`Expected =, ~=, >= or <= after "${attr}".`);

    // The value runs to the closing parenthesis. An unescaped * is a wildcard; split the raw text on those first,
    // then decode each piece, so an escaped \2a is a literal asterisk.
    const pieces = [''];
    for (; i < text.length && text[i] !== ')'; i++) {
      const ch = text[i];
      if (ch === '(') fail(`Unescaped "(" at position ${i + 1}; write it as \\28.`);
      if (ch === '*') {
        pieces.push('');
      } else if (ch === '\\') {
        if (!/^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) fail(`Invalid escape at position ${i + 1}; use \\ followed by two hex digits.`);
        pieces[pieces.length - 1] += text.slice(i, i + 3);
        i += 2;
      } else {
        pieces[pieces.length - 1] += ch;
      }
    }
    const values = pieces.map(unescape);

    if (op === 'eq' && values.length === 2 && values[0] === '' && values[1] === '') return { op: 'present', attr };
    if (op === 'eq' && values.length > 1) {
      return { op: 'sub', attr, initial: values[0], any: values.slice(1, -1), final: values[values.length - 1] };
    }
    if (values.length > 1) fail(`A wildcard can only be used with = (in ${attr}).`);
    return { op, attr, value: values[0] };
  }

  const node = filter(0);
  if (i !== text.length) fail(`Unexpected text at position ${i + 1}.`);
  return node;
}

const lower = (s) => String(s).toLowerCase();
const squash = (s) => lower(s).replace(/\s+/g, '');

// Compares numerically when both sides are numbers, otherwise as text, ignoring case.
function compareValues(a, b) {
  const x = String(a).trim();
  const y = String(b).trim();
  if (x !== '' && y !== '' && !Number.isNaN(Number(x)) && !Number.isNaN(Number(y))) return Number(x) - Number(y);
  if (lower(x) === lower(y)) return 0;
  return lower(x) < lower(y) ? -1 : 1;
}

// Does `value` start with `initial`, contain `any` in order, and end with `final`, without the pieces overlapping?
// Greedy matching is enough here: each piece is placed at its first possible position.
function substring(value, initial, any, final) {
  if (!value.startsWith(initial)) return false;
  let pos = initial.length;
  for (const piece of any) {
    const found = value.indexOf(piece, pos);
    if (found < 0) return false;
    pos = found + piece.length;
  }
  return value.length - final.length >= pos && value.endsWith(final);
}

function holds(node, values) {
  switch (node.op) {
    case 'present': return values.length > 0;
    case 'eq': return values.some((v) => lower(v) === lower(node.value));
    case 'approx': return values.some((v) => squash(v) === squash(node.value));
    case 'ge': return values.some((v) => compareValues(v, node.value) >= 0);
    case 'le': return values.some((v) => compareValues(v, node.value) <= 0);
    case 'sub': return values.some((v) => substring(lower(v), lower(node.initial), node.any.map(lower), lower(node.final)));
    default: return false;
  }
}

/**
 * Compiles filter text into a test on one record. `attributes` maps each searchable attribute name (lower case) to a
 * function that returns the record's values for it, as an array of non-empty strings. An attribute that is not in the
 * map is an error, so a misspelt name is reported instead of silently matching nothing.
 */
function compile(text, attributes) {
  const tree = parse(String(text));
  const build = (node) => {
    if (node.op === 'and') {
      const kids = node.kids.map(build);
      return (r) => kids.every((k) => k(r));
    }
    if (node.op === 'or') {
      const kids = node.kids.map(build);
      return (r) => kids.some((k) => k(r));
    }
    if (node.op === 'not') {
      const kid = build(node.kid);
      return (r) => !kid(r);
    }
    const values = attributes[lower(node.attr)];
    if (!values) fail(`Unknown attribute "${node.attr}". Searchable attributes: ${Object.keys(attributes).sort().join(', ')}.`);
    return (r) => holds(node, values(r));
  };
  return build(tree);
}

module.exports = { LdapFilterError, parse, compile };
