import { syntaxTree } from '@codemirror/language';

// Hover documentation for the names a script declares itself: variables, functions, parameters and loop variables. Each is
// described from where it is declared (what it was set from, what type that gives it, the comment above it) and, for a function,
// its inputs, what it returns and what it throws, from a /** JSDoc */ comment if there is one and otherwise from the code.
// Nothing here runs the script.

const SCOPES = new Set(['Script', 'Block', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration', 'ForStatement', 'CatchClause']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration']);
const NOT_INTO = new Set([...FUNCTIONS, 'ClassDeclaration']);
const SHORT = 100;

const squash = (text, max = SHORT) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const sentence = (text) => squash((text || '').replace(/^(.*?[.!?])(\s|$).*$/s, '$1'), 120);
const unquote = (text) => text.replace(/^(['"`])([\s\S]*)\1$/, '$2');

/** The declaration of `name` that is in scope at `pos`: { def, scope } or null. The innermost scope wins. */
export function findDeclaration(state, pos, name) {
  let best = null;
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name !== 'VariableDefinition' || state.sliceDoc(ref.from, ref.to) !== name) return;
      const def = ref.node;
      // A function's or class's own name belongs to the scope around it.
      let scope = ['FunctionDeclaration', 'ClassDeclaration'].includes(def.parent?.name) ? def.parent.parent : def.parent;
      while (scope && !SCOPES.has(scope.name)) scope = scope.parent;
      if (!scope || pos < scope.from || pos > scope.to) return;
      const before = def.from <= pos;
      if (!best || scope.from > best.scope.from || (scope.from === best.scope.from && before && def.from > best.def.from)) best = { def, scope };
    },
  });
  return best;
}

/* ------------------------------------ Comments ------------------------------------ */

// The text of the comment directly above a statement: a /** block */ or a run of // lines with no blank line between.
function commentAbove(state, statement) {
  const lines = [];
  let node = statement.prevSibling;
  let next = statement;
  while (node && ['LineComment', 'BlockComment'].includes(node.name)) {
    if (state.sliceDoc(node.to, next.from).split('\n').length > 2) break;
    if (node.name === 'BlockComment') return lines.length ? lines.reverse().join('\n') : state.sliceDoc(node.from, node.to);
    lines.push(state.sliceDoc(node.from, node.to).replace(/^\/\/\s?/, ''));
    next = node;
    node = node.prevSibling;
  }
  return lines.length ? lines.reverse().join('\n') : '';
}

/** Splits a comment into its description and JSDoc tags: { description, params: {name: {type, desc}}, returns, throws, example }. */
export function parseComment(raw) {
  const doc = { description: '', params: {}, returns: null, throws: null, example: '', type: null };
  if (!raw) return doc;
  const body = raw.startsWith('/*') ? raw.replace(/^\/\*+/, '').replace(/\*+\/$/, '').split('\n').map((l) => l.replace(/^\s*\*? ?/, '')) : raw.split('\n');
  const text = [];
  let tag = null;
  const tags = [];
  for (const line of body) {
    const m = /^\s*@(\w+)\s*(.*)$/.exec(line);
    if (m) { tag = { name: m[1], text: m[2] }; tags.push(tag); } else if (tag) tag.text += `\n${line}`; else text.push(line);
  }
  doc.description = text.join('\n').trim();
  for (const t of tags) {
    const body = t.text.trim();
    if (t.name === 'param' || t.name === 'arg' || t.name === 'argument') {
      const m = /^(?:\{([^}]*)\}\s*)?\[?([\w$.]+)(?:=[^\]\s]*)?\]?\s*-?\s*([\s\S]*)$/.exec(body);
      if (m) doc.params[m[2]] = { type: m[1] || '', desc: m[3].trim() };
    } else if (t.name === 'returns' || t.name === 'return') {
      const m = /^(?:\{([^}]*)\}\s*)?-?\s*([\s\S]*)$/.exec(body);
      doc.returns = { type: m[1] || '', desc: m[2].trim() };
    } else if (t.name === 'throws' || t.name === 'throw') {
      const m = /^(?:\{([^}]*)\}\s*)?-?\s*([\s\S]*)$/.exec(body);
      doc.throws = `${m[1] ? `${m[1]}: ` : ''}${m[2].trim()}`.replace(/:\s*$/, '');
    } else if (t.name === 'example') doc.example = t.text.replace(/^\n/, '').trimEnd();
    else if (t.name === 'type') doc.type = body.replace(/^\{|\}$/g, '');
  }
  return doc;
}

/* ------------------------------------ Describing ------------------------------------ */

// A short type label for { name, array } or { kind } from typeTools.
const label = (t) => (t ? (t.kind || `${t.name}${t.array ? '[]' : ''}`) : '');

/**
 * `ctx` is { docs, tools, reference, variables }: the Map from buildReferenceDocs, typeTools(docs, reference), and the names the
 * Inputs table gives the script. Returns the tip entry for `name` at `pos`, or null if the script does not declare it.
 */
export function describeLocal(state, pos, name, ctx) {
  const found = findDeclaration(state, pos, name);
  if (!found) return null;
  const { docs, tools } = ctx;
  const doc = state.sliceDoc(0, pos);
  const src = (n) => state.sliceDoc(n.from, n.to);

  // The type of an expression as a short phrase, or '' when it cannot be told. `depth` stops a function calling itself forever.
  function typeOfExpr(node, depth = 0) {
    if (!node || depth > 4) return '';
    switch (node.name) {
      case 'String': case 'TemplateString': return 'string';
      case 'Number': return 'number';
      case 'BooleanLiteral': return 'boolean';
      case 'null': return 'null';
      case 'ArrayExpression': return 'array';
      case 'RegExp': return 'RegExp';
      case 'ArrowFunction': case 'FunctionExpression': return 'function';
      case 'ObjectExpression': {
        const keys = [];
        for (let c = node.firstChild; c; c = c.nextSibling) {
          const key = c.name === 'Property' ? c.firstChild : c.name === 'PropertyDefinition' ? c : null;
          if (key) keys.push(unquote(src(key)));
        }
        return keys.length ? `{ ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''} }` : 'object';
      }
      case 'ParenthesizedExpression': return typeOfExpr(node.firstChild?.nextSibling, depth + 1);
      case 'AwaitExpression': return typeOfExpr(node.firstChild?.nextSibling, depth + 1);
      case 'NewExpression': return src(node.firstChild.nextSibling);
      case 'UnaryExpression': return src(node.firstChild) === '!' ? 'boolean' : '';
      case 'BinaryExpression': {
        const op = node.firstChild.nextSibling;
        if (op.name === 'CompareOp') return 'boolean';
        if (op.name === 'LogicOp') { const r = typeOfExpr(op.nextSibling, depth + 1); return r || typeOfExpr(node.firstChild, depth + 1); }
        const sides = [typeOfExpr(node.firstChild, depth + 1), typeOfExpr(op.nextSibling, depth + 1)];
        return sides.includes('string') ? 'string' : src(op) === '+' && sides.every((s) => s === 'number') ? 'number' : src(op) === '+' ? '' : 'number';
      }
      case 'ConditionalExpression': {
        const parts = [...new Set([typeOfExpr(node.firstChild.nextSibling?.nextSibling, depth + 1), typeOfExpr(node.lastChild, depth + 1)].filter(Boolean))];
        return parts.join(' | ');
      }
      case 'CallExpression': {
        const callee = node.firstChild;
        const path = src(callee).replace(/\?\./g, '.').replace(/\s+/g, '');
        const entry = docs.get(path);
        if (entry?.returns) {
          const t = tools.refType(entry.returns);
          if (t) return `${label(t)}${/\bnull\b/i.test(entry.returns) ? ' | null' : ''}`;
          return sentence(entry.returns).replace(/\.$/, '');
        }
        if (callee.name === 'VariableName') {
          const local = findDeclaration(state, node.from, path);
          const fn = local && functionOf(local.def);
          if (fn) return signatureParts(fn, depth + 1).returns;
        }
        const t = tools.typeOf(path, true, doc, 0);
        return t ? label(t) : '';
      }
      case 'MemberExpression': {
        const path = src(node).replace(/\?\./g, '.').replace(/\s+/g, '');
        const dot = path.lastIndexOf('.');
        const parent = dot > 0 ? tools.typeOf(path.slice(0, dot), false, doc, 0) : null;
        const field = parent?.name && !parent.array ? tools.types.get(parent.name).fields.find((f) => f.name === path.slice(dot + 1)) : null;
        return field ? field.type : '';
      }
      case 'VariableName': {
        const t = tools.variableType(src(node), doc, 0);
        if (t) return label(t);
        // Otherwise whatever the variable was first set to in the script.
        const decl = findDeclaration(state, node.from, src(node));
        const init = decl?.def.parent?.name === 'VariableDeclaration' ? valueOf(decl.def) : null;
        return init && init.from !== node.from ? typeOfExpr(init, depth + 1) : '';
      }
      default: return '';
    }
  }

  // The function a declaration defines: itself, or the function a variable was set to.
  function functionOf(def) {
    if (def.parent?.name === 'FunctionDeclaration') return { node: def.parent, statement: def.parent };
    if (def.parent?.name === 'VariableDeclaration') {
      const init = valueOf(def);
      if (init && (init.name === 'ArrowFunction' || init.name === 'FunctionExpression')) return { node: init, statement: def.parent };
    }
    return null;
  }

  // The expression a variable was set to.
  function valueOf(def) {
    const eq = def.nextSibling;
    return eq?.name === 'Equals' ? eq.nextSibling : null;
  }

  const bodyOf = (fn) => { for (let c = fn.lastChild; c; c = c.prevSibling) if (c.name !== ';') return c; return null; };

  // Statements of one kind inside a function, not counting those of functions inside it.
  function within(node, name, out = []) {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (NOT_INTO.has(c.name)) continue;
      if (c.name === name) out.push(c);
      within(c, name, out);
    }
    return out;
  }

  // What a function takes, returns and throws, from its comment and code.
  function signatureParts({ node, statement }, depth = 0) {
    const comment = parseComment(commentAbove(state, statement));
    const list = node.getChild('ParamList');
    const params = [];
    for (let c = list?.firstChild; c; c = c.nextSibling) {
      if (['(', ')', ','].includes(c.name) || c.name === 'Spread') continue;
      const rest = c.prevSibling?.name === 'Spread';
      let text = src(c);
      let name = text;
      let inferred = rest ? 'array' : '';
      if (c.name === 'VariableDefinition') {
        const eq = c.nextSibling;
        if (eq?.name === 'Equals') { text = `${text} = ${squash(src(eq.nextSibling), 30)}`; inferred = typeOfExpr(eq.nextSibling, depth); }
      } else if (c.name === 'ObjectPattern') {
        name = squash(text, 40);
        inferred = 'object';
      } else if (c.name === 'ArrayPattern') { name = squash(text, 40); inferred = 'array'; }
      else continue;
      const jd = comment.params[name] || {};
      params.push({ name: `${rest ? '...' : ''}${name}`, type: jd.type || inferred, desc: jd.desc || '' });
    }
    const body = bodyOf(node);
    const returns = body && body.name !== 'Block' && body.name !== 'ParamList' ? [body] : within(body || node, 'ReturnStatement').map((r) => r.firstChild?.nextSibling).filter((x) => x && x.name !== ';');
    const returned = [...new Set(returns.map((r) => typeOfExpr(r, depth)).filter(Boolean))];
    const isAsync = Boolean(node.getChild('async'));
    const sentenceOf = (jd) => (jd ? `${jd.type ? `${jd.type}. ` : ''}${jd.desc}`.trim() : '');
    let result = comment.returns ? sentenceOf(comment.returns) : returned.join(' | ') || (returns.length ? '' : 'nothing (undefined)');
    if (isAsync && result && !comment.returns) result = `${result}, as a promise: use await`;
    else if (isAsync && !result) result = 'a promise: use await';
    const thrown = within(body || node, 'ThrowStatement').map((t) => {
      const created = t.firstChild?.nextSibling;
      const arg = created?.name === 'NewExpression' ? created.getChild('ArgList')?.firstChild?.nextSibling : null;
      return arg ? unquote(squash(src(arg), 70)) : '';
    }).filter(Boolean);
    return {
      comment, params, returns: result, isAsync,
      throws: comment.throws || (thrown.length ? [...new Set(thrown)].slice(0, 3).join('; ') : ''),
      paramText: list ? squash(src(list), 120) : '()',
    };
  }

  const { def } = found;
  const kindNode = def.parent;

  // A function.
  const fn = functionOf(def);
  if (fn) {
    const s = signatureParts(fn);
    const arrow = fn.node.name === 'ArrowFunction';
    const keyword = kindNode.name === 'VariableDeclaration' ? src(kindNode.firstChild) : 'function';
    return {
      sig: arrow || fn.node.name === 'FunctionExpression' ? `${keyword} ${name} = ${s.isAsync ? 'async ' : ''}${arrow ? `${s.paramText} =>` : `function${s.paramText}`} …` : `${s.isAsync ? 'async ' : ''}function ${name}${s.paramText}`,
      desc: s.comment.description,
      params: s.params.length ? s.params : undefined,
      returns: s.returns,
      throws: s.throws,
      example: s.comment.example,
      note: undefined,
    };
  }

  // A class.
  if (kindNode.name === 'ClassDeclaration') {
    const ext = kindNode.getChild('extends');
    return { sig: `class ${name}${ext ? ` extends ${src(ext.nextSibling)}` : ''}`, desc: parseComment(commentAbove(state, kindNode)).description, type: 'class' };
  }

  // A catch parameter.
  if (kindNode.name === 'CatchClause') {
    return { sig: `catch (${name})`, desc: 'The error that was thrown. It is usually an Error: err.message says what went wrong.', type: 'Error' };
  }

  // A loop variable.
  if (['ForOfSpec', 'ForInSpec'].includes(kindNode.name)) {
    const of = kindNode.getChild('of') || kindNode.getChild('in');
    const iterable = of?.nextSibling;
    const type = tools.variableType(name, doc, 0);
    const kw = kindNode.firstChild?.nextSibling?.name === 'const' ? 'const' : src(kindNode.firstChild.nextSibling);
    return {
      sig: `${['const', 'let', 'var'].includes(kw) ? kw : 'let'} ${name}${type ? `: ${label(type)}` : ''}`,
      desc: of?.name === 'in' ? `Each key of ${iterable ? squash(src(iterable), 60) : 'the object'}, in turn.` : `Each value of ${iterable ? squash(src(iterable), 60) : 'the list'}, in turn.`,
      type: type?.name ? undefined : of?.name === 'in' ? 'string' : undefined,
      fields: type?.name ? fieldNames(type.name) : undefined,
    };
  }

  // A parameter.
  const owner = FUNCTIONS.has(kindNode.parent?.name) && kindNode.name === 'ParamList' ? kindNode.parent : null;
  if (owner) {
    const type = tools.variableType(name, doc, 0);
    let fnName = '';
    const holder = owner.parent;
    if (owner.name === 'FunctionDeclaration') fnName = src(owner.getChild('VariableDefinition'));
    else if (holder?.name === 'VariableDeclaration') fnName = src(holder.getChild('VariableDefinition') || holder.firstChild.nextSibling);
    const jd = fnName && holder ? parseComment(commentAbove(state, owner.name === 'FunctionDeclaration' ? owner : holder)).params[name] : null;
    const eq = def.nextSibling;
    const fromDefault = eq?.name === 'Equals' ? typeOfExpr(eq.nextSibling) : '';
    return {
      sig: `(parameter) ${name}${jd?.type || type || fromDefault ? `: ${jd?.type || label(type) || fromDefault}` : ''}`,
      desc: jd?.desc || (fnName ? `An input of ${fnName}${jd ? '' : ': the caller supplies it'}.` : 'A parameter of the callback; its value is supplied by whatever calls it.'),
      fields: type?.name ? fieldNames(type.name) : undefined,
    };
  }

  // A variable, possibly taken out of a larger value.
  const statement = ['PatternProperty', 'ObjectPattern', 'ArrayPattern'].includes(kindNode.name) ? ancestorNamed(kindNode, 'VariableDeclaration') : kindNode;
  if (statement?.name !== 'VariableDeclaration') return { sig: name, desc: '' };
  const keyword = src(statement.firstChild);
  const comment = parseComment(commentAbove(state, statement));
  const destructured = kindNode.name !== 'VariableDeclaration';
  let init = null;
  for (let c = statement.firstChild; c; c = c.nextSibling) if (c.name === 'Equals') init = c.nextSibling;
  const call = init && (init.name === 'AwaitExpression' ? init.firstChild.nextSibling : init);
  const callee = call?.name === 'CallExpression' ? src(call.firstChild).replace(/\?\./g, '.').replace(/\s+/g, '') : '';
  const entry = callee ? docs.get(callee) : null;
  const out = { sig: `${keyword} ${name}`, desc: '', from: init ? squash(src(init)) : undefined };

  if (destructured) {
    const key = kindNode.name === 'PatternProperty' ? src(kindNode.getChild('PropertyName') || def) : null;
    const parent = init ? typeOfExpr(init) : '';
    const base = parent && tools.refType(parent);
    const field = key && base?.name ? tools.types.get(base.name).fields.find((f) => f.name === key) : null;
    out.sig = `${keyword} ${name}${field ? `: ${field.type}` : ''}`;
    out.desc = field ? field.description : key ? `The "${key}" part of ${entry ? 'what this returns' : 'the value above'}${entry?.returns ? `: ${sentence(entry.returns)}` : '.'}` : 'One of the values taken out of the list or object above.';
    out.note = comment.description || undefined;
    return out;
  }

  const stated = comment.type || typeOfExpr(init);
  const refined = stated === 'array' ? arrayOf(name, doc) : stated;
  out.sig = `${keyword} ${name}${refined ? `: ${refined}` : ''}`;
  out.desc = comment.description || (entry ? entry.desc : '');
  // The shape the function returned, so a later `name.key` can be described.
  if (entry?.returns?.startsWith('{')) out.shape = entry.returns;
  if (entry?.returns && !tools.refType(entry.returns)) out.returns = sentence(entry.returns);
  const type = init ? tools.variableType(name, doc, 0) : null;
  if (type?.name) out.fields = fieldNames(type.name);
  if (type?.name && type.array) out.desc = out.desc || `A list of ${type.name} objects.`;
  if (!comment.description && !entry && !refined && !init) out.desc = 'Declared without a value; it is undefined until it is set.';
  return out;

  function fieldNames(typeName) {
    const names = tools.types.get(typeName)?.fields.map((f) => f.name) || [];
    return names.length ? `${names.slice(0, 14).join(', ')}${names.length > 14 ? ', …' : ''}` : undefined;
  }

  // "array" becomes "string[]" or "number[]" when the script pushes such values onto it.
  function arrayOf(varName, text) {
    const m = new RegExp(`(?<![\\w$.])${varName.replace(/[$]/g, '\\$')}\\.push\\(\\s*(['"\`]|\\d|\\{|\\[)`).exec(text + state.sliceDoc(pos));
    if (!m) return 'array';
    return /['"`]/.test(m[1]) ? 'string[]' : /\d/.test(m[1]) ? 'number[]' : m[1] === '{' ? 'object[]' : 'array[]';
  }
}

function ancestorNamed(node, name) {
  for (let n = node; n; n = n.parent) if (n.name === name) return n;
  return null;
}
