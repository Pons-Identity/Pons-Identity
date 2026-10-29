import { expect, test } from 'vitest';
import { buildReferenceDocs, lookup } from './codeHover.js';

const reference = {
  variables: [{ name: 'vars', description: 'Your variables.', example: 'vars.KEY' }],
  functions: [
    { group: 'Users', scope: 'users:read', items: [{ signature: 'await idp.users.find({ id | username })', description: 'Looks one user up.', returns: 'User, or null.', throws: 'If no key.', example: 'await idp.users.find({ username: "a" });' }] },
    { group: 'Outside services', scope: 'http', items: [{ signature: 'http.put(url, body, opts), http.patch(url, body, opts), http.delete(url, opts)', description: 'The other methods.', returns: 'HttpResponse.' }] },
    { group: 'Helpers', scope: null, items: [{ signature: 'log(...values), log.warning(...)', description: 'Writes a log line.', returns: 'nothing.' }] },
    { group: 'Your functions', scope: null, items: [{ signature: 'await fn.NAME({ ... })', description: 'Calls a function.', returns: 'Whatever it returns.' }, { signature: 'await fn.chunk({ items: value, size: value })', description: 'Splits a list.', returns: 'Whatever it returns.' }] },
  ],
};
const ref = buildReferenceDocs(reference);
const text = (path) => lookup(path, ref)?.map((d) => d.textContent).join('\n');

test('script API names show their signature, description, returns, throws, scope and example', () => {
  const tip = text('idp.users.find');
  expect(tip).toContain('await idp.users.find({ id | username })');
  expect(tip).toContain('Looks one user up.');
  expect(tip).toContain('Returns User, or null.');
  expect(tip).toContain('Throws If no key.');
  expect(tip).toContain('Needs scope users:read');
  expect(tip).toContain('Example');
});

test('a signature that lists several functions gives each its own entry', () => {
  expect(text('http.patch')).toContain('http.patch(url, body, opts)');
  expect(text('http.delete')).toContain('The other methods.');
  expect(text('log.warning')).toContain('Writes a log line.');
  expect(text('console.warn')).toContain('console.warn(...values)');
});

test('a namespace lists what it holds, and variables and your own functions are found', () => {
  expect(text('idp')).toContain('await idp.users.find');
  expect(text('vars')).toContain('Your variables.');
  expect(text('fn.chunk')).toContain('Splits a list.');
  expect(text('fn.addedLater')).toContain('Calls a function.');
});

test('JavaScript built-ins are documented without a reference', () => {
  const none = buildReferenceDocs(null);
  const bare = (p) => lookup(p, none)?.map((d) => d.textContent).join('\n');
  expect(bare('JSON.stringify')).toContain('Turns a value into JSON text');
  expect(bare('Math')).toContain('Numeric functions');
  expect(bare('await')).toContain('Pauses the script');
  expect(bare('users.map')).toContain('array.map');
  expect(bare('email.includes')).toContain('string.includes');
  expect(bare('email.includes')).toContain('array.includes');
});

test('other names have no tip', () => {
  expect(lookup('user', ref)).toBeNull();
  expect(lookup('user.email', ref)).toBeNull();
  expect(lookup('constructor', ref)).toBeNull();
  expect(lookup('x.constructor', ref)).toBeNull();
});
