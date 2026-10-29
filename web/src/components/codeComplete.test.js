import { CompletionContext } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { expect, test } from 'vitest';
import { completionSource } from './codeComplete.js';
import { buildReferenceDocs } from './codeHover.js';

const field = (name, type, extra = {}) => ({ name, type, description: `${name} note`, ...extra });
const reference = {
  variables: [{ name: 'vars', description: 'Your variables.' }, { name: 'input', description: 'The input.' }],
  functions: [
    { group: 'Users', scope: 'users:read', items: [
      { signature: 'await idp.users.find({ id | username | email })', description: 'Looks one user up.', returns: 'User, or null.' },
      { signature: 'await idp.users.search(text | { q, limit })', description: 'Search.', returns: 'User[] (at most 50).' },
    ] },
    { group: 'Users', scope: 'users:write', items: [
      { signature: 'await idp.users.create(NewUser)', description: 'Creates.', returns: 'User.' },
      { signature: 'await idp.users.update(user, UserPatch)', description: 'Changes.', returns: 'User, after the change.' },
    ] },
    { group: 'Outside services', scope: 'http', items: [
      { signature: 'await http.get(url, { headers })', description: 'GET.', returns: 'HttpResponse.' },
      { signature: 'await http.request(HttpRequest)', description: 'Any method.', returns: 'HttpResponse.' },
    ] },
    { group: 'Helpers', scope: null, items: [
      { signature: 'await sleep(ms)', description: 'Waits.', returns: 'true.' },
      { signature: 'log(...values), log.warning(...)', description: 'Log.', returns: 'nothing.' },
      { signature: 'return value', description: 'The result.', returns: '' },
    ] },
    { group: 'Your functions', scope: null, items: [
      { signature: 'await fn.NAME({ ... })', description: 'Calls a function.', returns: 'x' },
      { signature: 'await fn.chunk({ items: value, size: value })', description: 'Splits.', returns: 'Whatever it returns.' },
    ] },
  ],
  types: [
    { name: 'User', fields: [field('username', 'string', { required: true }), field('email', 'string'), field('groups', 'string[]'), field('manager', 'string')] },
    { name: 'NewUser', fields: [field('username', 'string', { required: true }), field('email', 'string'), field('generate_password', 'boolean')] },
    { name: 'UserPatch', fields: [field('title', 'string'), field('active', 'boolean'), field('attributes', 'object')] },
    { name: 'HttpRequest', fields: [field('url', 'string', { required: true }), field('method', 'string')] },
    { name: 'HttpResponse', fields: [field('status', 'number'), field('ok', 'boolean'), field('json', 'any')] },
    { name: 'Trigger', fields: [field('type', 'string'), field('at', 'string')] },
  ],
  attributes: { defined: [{ name: 'badge_expires', label: 'Badge expires', type: 'date', example: '2027-06-30', options: [], required: false }] },
};
const docs = buildReferenceDocs(reference);
const source = completionSource({ docs, reference, variables: ['username', 'days'] });

// Completions at the "|" in the code.
function at(code, explicit = false) {
  const pos = code.indexOf('|');
  const doc = code.replace('|', '');
  const state = EditorState.create({ doc, extensions: [javascript()] });
  const result = source(new CompletionContext(state, pos, explicit));
  return result && result.options;
}
const labels = (code, explicit) => (at(code, explicit) || []).map((o) => o.label);

test('after a dot, the script API offers what is under that name', () => {
  expect(labels('idp.|')).toEqual(['users']);
  expect(labels('await idp.users.|')).toEqual(expect.arrayContaining(['find', 'search', 'create', 'update']));
  expect(labels('await http.ge| })')).toContain('get');
  expect(labels('log.|')).toEqual(['warning']);
  expect(labels('await fn.|')).toEqual(['chunk']);
});

test('a function is inserted as a call with its arguments to fill in', () => {
  const find = at('await idp.users.|').find((o) => o.label === 'find');
  expect(find.type).toBe('function');
  expect(find.detail).toBe('User');
  expect(typeof find.apply).toBe('function');
  expect(at('await fn.|')[0].apply).toBeTypeOf('function');
});

test('a plain word offers the script API, the Inputs table variables and JavaScript globals', () => {
  const names = labels('const x = i|');
  expect(names).toEqual(expect.arrayContaining(['idp', 'http', 'log', 'sleep', 'fn', 'input', 'JSON', 'Math', 'parseInt', 'username', 'days']));
  expect(names).not.toContain('return');
  expect(labels('|')).toEqual([]);
  expect(labels('|', true)).toContain('idp');
});

test('JavaScript statics are offered after their object', () => {
  expect(labels('Math.|')).toEqual(expect.arrayContaining(['round', 'max', 'PI']));
  expect(labels('JSON.|')).toEqual(['stringify', 'parse']);
});

test('the fields of a value come from its type, worked out from the script', () => {
  expect(labels('const u = await idp.users.find({ username });\nu.|')).toEqual(['username', 'email', 'groups', 'manager']);
  expect(labels('const u = await idp.users.find({ username });\nu?.em|')).toContain('email');
  expect(labels('const r = await http.get(url);\nif (r.|')).toEqual(['status', 'ok', 'json']);
  expect(labels('trigger.|')).toEqual(['type', 'at']);
});

test('types follow arrays: a loop, a callback, find and filter', () => {
  const users = 'const users = await idp.users.search("a");\n';
  expect(labels(`${users}for (const u of users) { u.| }`)).toContain('email');
  expect(labels(`${users}users.map((u) => u.|)`)).toContain('manager');
  expect(labels(`${users}const sam = users.find((x) => x.ok);\nsam.|`)).toContain('username');
  expect(labels(`${users}const some = users.filter(Boolean);\nsome.|`)).toContain('map');
  expect(labels(`${users}users.|`)).toContain('filter');
  expect(labels(`${users}users.|`)).not.toContain('username');
  expect(labels(`${users}const s = users[0];\ns.|`)).toContain('trim')  // users[0] is not tracked: any method;
  expect(labels(`${users}for (const g of users) {}\nconst m = g;\nm.|`)).toContain('email')  // an alias keeps the type;
});

test('a string field offers string methods; an unknown value offers methods of any kind', () => {
  const u = 'const u = await idp.users.find({ username });\n';
  expect(labels(`${u}u.email.|`)).toEqual(expect.arrayContaining(['trim', 'toLowerCase', 'length']));
  expect(labels(`${u}u.email.|`)).not.toContain('push');
  expect(labels('mystery.|')).toEqual(expect.arrayContaining(['map', 'trim', 'toFixed', 'push']));
});

// With nothing typed yet the keys show on Ctrl+Space (explicit); once a letter is typed they show by themselves.
test('the keys of an object passed to a call come from the type that call takes', () => {
  expect(labels('await idp.users.create({ | });', true)).toEqual(['username', 'email', 'generate_password']);
  expect(labels('await idp.users.create({ username: "a", e| });')).toEqual(['email', 'generate_password']);
  expect(labels('await idp.users.update(u.id, { | });', true)).toEqual(['title', 'active', 'attributes']);
  expect(labels('await http.request({ u| });')).toEqual(['url', 'method']);
  const create = at('await idp.users.create({ | });', true).find((o) => o.label === 'email');
  expect(create.apply).toBe('email: ');
});

test('keys are not offered as a value, in another call, or for a call with no type', () => {
  expect(labels('await idp.users.create({ username: | });', true)).not.toContain('email');
  expect(labels('await idp.users.find({ | });', true)).not.toContain('email');
  expect(labels('const o = { | };', true)).not.toContain('email');
});

test('inside attributes, the attributes defined in Settings are offered', () => {
  const found = at('await idp.users.update(u.id, { attributes: { | } });', true);
  expect(found.map((o) => o.label)).toEqual(['badge_expires']);
});

test('nothing is offered inside a comment or a string', () => {
  expect(at('// idp.|')).toBeNull();
  expect(at('const s = "idp.|"')).toBeNull();
});

test('with no reference, JavaScript is still completed', () => {
  const bare = completionSource({ docs: buildReferenceDocs(null), reference: null });
  const state = EditorState.create({ doc: 'Math.', extensions: [javascript()] });
  expect(bare(new CompletionContext(state, 5, false)).options.map((o) => o.label)).toContain('round');
});
