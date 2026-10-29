import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { expect, test } from 'vitest';
import { buildReferenceDocs, hoverSource, lookup } from './codeHover.js';
import { describeLocal, parseComment } from './codeLocals.js';
import { typeTools } from './codeTypes.js';

const field = (name, type, description = '') => ({ name, type, description });
const reference = {
  variables: [],
  functions: [
    { group: 'Users', scope: 'users:read', items: [{ signature: 'await idp.users.find({ id | username | email | employee_id })', description: 'Looks one user up.', returns: 'User, or null if there is none.' }] },
    { group: 'Users', scope: 'users:write', items: [{ signature: 'await idp.users.resetAuthenticators(user)', description: 'Removes every sign-in method.', returns: '{ removed } (the number of methods removed).' }] },
    { group: 'Compromised accounts', scope: 'users:read', items: [{ signature: 'await idp.compromise.plan(user)', description: 'The lockdown steps that apply to a person.', returns: '{ end_sessions, reset_password, notify_user: boolean, groups: string[] }.' }] },
    { group: 'Groups', scope: 'groups:read', items: [{ signature: 'await idp.groups.list()', description: 'Every group.', returns: 'Group[].' }] },
  ],
  types: [
    { name: 'User', fields: [field('username', 'string', 'Sign-in name.'), field('email', 'string', 'The primary address.'), field('personal_email', 'string | null')] },
    { name: 'Group', fields: [field('id', 'number'), field('name', 'string')] },
  ],
};
const docs = buildReferenceDocs(reference);
const ctx = { docs, tools: typeTools(docs, reference), reference, variables: ['username'] };

// The tip for the word at "|" (put the bar inside the word you hover).
function tip(code, name, at) {
  // `at` hovers at the first place that text appears, for a name whose scope does not reach the bar.
  const pos = at ? code.indexOf(at) + 1 : code.indexOf('|');
  const state = EditorState.create({ doc: code.replace('|', ''), extensions: [javascript()] });
  return describeLocal(state, pos, name, ctx);
}

const LOCKDOWN = `// Locks down one account.
if (!username) throw new Error('Say which account to lock down: pass a username.');
const user = await idp.users.find({ username });
if (!user) throw new Error('There is no user "' + username + '".');
const plan = await idp.compromise.plan(user.username);
const done = [];
if (plan.end_sessions) { done.push('signed out everywhere'); }
if (plan.rotate_mfa) {
  const { removed } = await idp.users.resetAuthenticators(user.username);
  done.push('removed ' + removed);
}
for (const group of plan.groups) {
  done.push('added to ' + group);
}
const to = user.personal_email || user.email;
us|er.email;
`;

test('a variable set from a reference function gets its type, source, description and fields', () => {
  const t = tip(LOCKDOWN, 'user');
  expect(t.sig).toBe('const user: User | null');
  expect(t.from).toBe('await idp.users.find({ username })');
  expect(t.desc).toBe('Looks one user up.');
  expect(t.fields).toBe('username, email, personal_email');
});

test('a variable whose function returns an object shows that shape', () => {
  const t = tip(LOCKDOWN, 'plan');
  expect(t.sig).toMatch(/^const plan: \{ end_sessions, reset_password/);
  expect(t.desc).toContain('lockdown steps');
  expect(t.from).toBe('await idp.compromise.plan(user.username)');
});

test('a list the script pushes strings onto is a list of strings', () => {
  expect(tip(LOCKDOWN, 'done').sig).toBe('const done: string[]');
});

test('a value taken out of a result is described by the part it takes', () => {
  const t = tip(LOCKDOWN, 'removed', '{ removed');
  expect(t.sig).toBe('const removed');
  expect(t.desc).toContain('"removed" part of what this returns');
  expect(t.from).toBe('await idp.users.resetAuthenticators(user.username)');
});

test('a loop variable says what it loops over', () => {
  const t = tip(LOCKDOWN, 'group', 'const group');
  expect(t.sig).toBe('const group');
  expect(t.desc).toBe('Each value of plan.groups, in turn.');
});

test('an expression built from fields of a known type takes the type of the one it ends up with', () => {
  expect(tip(LOCKDOWN, 'to').sig).toBe('const to: string');
});

test('names that are not declared have no tip, and a name in another scope is not found', () => {
  expect(tip(LOCKDOWN, 'username')).toBeNull();
  expect(tip('function f() { const inner = 1; }\ninn|er;', 'inner')).toBeNull();
});

test('a function is described from its JSDoc', () => {
  const t = tip(`/**
 * Finds the people in a department.
 * @param {string} department - The department name.
 * @param {number} [limit=10] How many to return.
 * @returns {User[]} The matching users.
 * @throws {Error} If the department is blank.
 * @example
 * await byDepartment("Sailing");
 */
async function byDepartment(department, limit = 10) { return []; }
byDep|artment("x");`, 'byDepartment');
  expect(t.sig).toBe('async function byDepartment(department, limit = 10)');
  expect(t.desc).toBe('Finds the people in a department.');
  expect(t.params).toEqual([
    { name: 'department', type: 'string', desc: 'The department name.' },
    { name: 'limit', type: 'number', desc: 'How many to return.' },
  ]);
  expect(t.returns).toBe('User[]. The matching users.');
  expect(t.throws).toBe('Error: If the department is blank.');
  expect(t.example).toBe('await byDepartment("Sailing");');
});

test('without a JSDoc, a function\'s inputs, return and errors are worked out from the code', () => {
  const t = tip(`// Adds a person to the staff group.
const enroll = async (name, { notify, dry = false }, times = 3) => {
  if (!name) throw new Error("Give a name");
  const u = await idp.users.find({ username: name });
  if (!u) return null;
  return { enrolled: u.username, notify };
};
await en|roll("a", {});`, 'enroll');
  expect(t.sig).toBe('const enroll = async (name, { notify, dry = false }, times = 3) =>  …'.replace('=>  …', '=> …'));
  expect(t.desc).toBe('Adds a person to the staff group.');
  expect(t.params.map((p) => p.name)).toEqual(['name', '{ notify, dry = false }', 'times']);
  expect(t.params[2].type).toBe('number');
  expect(t.returns).toContain('null');
  expect(t.returns).toContain('{ enrolled, notify }');
  expect(t.returns).toContain('promise');
  expect(t.throws).toBe('Give a name');
});

test('a call to a function declared in the script shows what that function returns', () => {
  const t = tip('function twice(n) { return n * 2; }\nconst r = twice(4);\nr|;', 'r');
  expect(t.sig).toBe('const r: number');
});

test('a parameter takes its description from the JSDoc, or says who supplies it', () => {
  const doc = tip('/** @param {string} who - The person. */\nfunction hi(who) { return wh|o; }', 'who');
  expect(doc.sig).toBe('(parameter) who: string');
  expect(doc.desc).toBe('The person.');
  const callback = tip('const users = await idp.users.find({ username });\nlist.map((u) => u|);', 'u');
  expect(callback.sig).toBe('(parameter) u');
  expect(callback.desc).toContain('callback');
});

test('a catch variable is an Error', () => {
  expect(tip('try {} catch (err) { er|r; }', 'err').type).toBe('Error');
});

test('comments above a variable become its description', () => {
  expect(tip('// How long to wait.\nconst delay = 30;\ndel|ay;', 'delay').desc).toBe('How long to wait.');
  expect(tip('// Not about this.\n\nconst delay = 30;\ndel|ay;', 'delay').desc).toBe('');
});

test('JSDoc comments are split into description and tags', () => {
  const doc = parseComment('/**\n * Does it.\n * More.\n * @param {number} a - one\n * @returns the thing\n */');
  expect(doc.description).toBe('Does it.\nMore.');
  expect(doc.params.a).toEqual({ type: 'number', desc: 'one' });
  expect(doc.returns).toEqual({ type: '', desc: 'the thing' });
});

test('keywords show their syntax and the equivalent in other languages', () => {
  const text = (w) => lookup(w, docs)?.map((d) => d.textContent).join('\n');
  expect(text('if')).toContain('else if');
  expect(text('if')).toContain('Python: elif');
  expect(text('for')).toContain('for (const x of list)');
  expect(text('while')).toContain('while (condition)');
  expect(text('switch')).toContain('case');
  expect(text('function')).toContain('Python: def');
  expect(text('import')).toContain('Not available');
});

test('a name the script declares hides the script API name it shares', () => {
  expect(lookup('log', docs, true)).toBeNull();
  expect(lookup('log.push', docs, true)?.[0].textContent).toContain('array.push');
});

// The hover as the editor asks for it, in a real view.
function hover(code) {
  const pos = code.indexOf('|');
  const view = new EditorView({ parent: document.body, doc: code.replace('|', ''), extensions: [javascript()] });
  const tooltip = hoverSource(docs, { reference, variables: ['username'] })(view, pos);
  const made = tooltip && tooltip.create();
  return { tooltip, made, text: made?.dom.textContent, view };
}

test('hovering a declared name shows its tip, fading in', () => {
  const { tooltip, made, text, view } = hover('const user = await idp.users.find({ username });\nreturn us|er;');
  expect(text).toContain('const user: User | null');
  expect(text).toContain('Fields');
  expect(tooltip.pos).toBe(view.state.doc.toString().lastIndexOf('user'));
  expect(made.dom.style.opacity).toBe('0');
  made.mount();
  expect(made.dom.style.opacity).toBe('1');
  expect(made.dom.style.transition).toContain('200ms');
});

test('hovering a field of a typed value shows the field, and a method on it still works', () => {
  expect(hover('const user = await idp.users.find({ username });\nuser.em|ail;').text).toContain('email: string');
  expect(hover('const user = await idp.users.find({ username });\nuser.email.trim|();').text).toContain('string.trim');
});

test('a name from the Inputs table, and the script API, are still described', () => {
  expect(hover('return user|name;').text).toContain('Inputs table');
  expect(hover('await idp.users.fi|nd({});').text).toContain('Looks one user up.');
  expect(hover('i|f (x) {}').text).toContain('else if');
  expect(hover('const x = 1;\nnothing_he|re;').tooltip).toBeNull();
});

const withFns = {
  ...reference,
  variables: [{ name: 'vars', description: 'Your variables.' }, { name: 'input', description: 'The input.' }],
  inputs: [{ name: 'email', description: 'The primary address.' }],
  functions: [...reference.functions, { group: 'Your functions', scope: null, items: [
    { signature: 'await fn.NAME({ ... })', description: 'Calls a function.', returns: 'Whatever the function returns.' },
    { signature: 'await fn.normalizeEmail({ email: value })', description: 'Trims.', returns: 'Whatever it returns.', example: 'await fn.normalizeEmail({ email: "x" });',
      fn: { name: 'normalizeEmail', description: 'Trims and lower-cases an address.', inputs: [{ name: 'email', variable: 'address' }],
        script: '/** Cleans an address.\n * @param {string} address - Any spelling.\n * @returns {string|null} The clean address, or null. */\nif (!address) throw new Error("Give an address");\nreturn address.trim().toLowerCase();' } },
    { signature: 'await fn.chunk({ items: value })', description: 'Splits.', returns: 'Whatever it returns.',
      fn: { name: 'chunk', description: 'Splits a list.', inputs: [{ name: 'items', variable: 'items' }, { name: 'size', variable: 'size' }], script: '// Groups of size.\nconst out = [];\nreturn out;' } },
  ] }],
};

test('a function of your own shows its inputs, return, errors, example and a link to its page', () => {
  const d = buildReferenceDocs(withFns);
  const e = d.get('fn.normalizeEmail');
  expect(e.desc).toBe('Cleans an address.');
  expect(e.params).toEqual([{ name: 'email (read as address)', type: 'string', desc: 'Any spelling.' }]);
  expect(e.returns).toBe('string|null. The clean address, or null.');
  expect(e.throws).toBe('Give an address');
  expect(e.link).toBe('/admin/integrations/functions/normalizeEmail');
  const dom = lookup('fn.normalizeEmail', d)[0];
  const a = dom.querySelector('a');
  expect(a.getAttribute('href')).toBe('/admin/integrations/functions/normalizeEmail');
  expect(a.target).toBe('_blank');
  expect(a.rel).toContain('noopener');
  expect(dom.textContent).toContain('Inputs');
});

test('without a docstring, the inputs and return are worked out and the Description is used', () => {
  const e = buildReferenceDocs(withFns).get('fn.chunk');
  expect(e.desc).toBe('Groups of size.');
  expect(e.params.map((p) => p.name)).toEqual(['items', 'size']);
  expect(e.returns).toBe('array');
});

test('a variable set from a function of your own shows what it returns; a field of a returned object is described', () => {
  const d = buildReferenceDocs(withFns);
  const c = { docs: d, tools: typeTools(d, withFns), reference: withFns, variables: [] };
  const code = 'const batches = await fn.chunk({ items: x });\nconst plan = await idp.compromise.plan("a");\nbat|ches;';
  const state = EditorState.create({ doc: code.replace('|', ''), extensions: [javascript()] });
  expect(describeLocal(state, code.indexOf('|'), 'batches', c).desc).toBe('Groups of size.');
  const view = new EditorView({ parent: document.body, doc: 'const plan = await idp.compromise.plan("a");\nplan.groups;\nvars.KEY;\ninput.days;', extensions: [javascript()] });
  const src = hoverSource(d, { reference: withFns });
  const text = (needle) => { const t = src(view, view.state.doc.toString().indexOf(needle) + 1); return t ? t.create().dom.textContent : `no tip for ${needle}`; };
  expect(text('groups')).toContain('groups: string[]');
  expect(text('KEY')).toContain('Integrations → Variables');
  expect(text('days')).toContain('The value the run was given for days');
});
