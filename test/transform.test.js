const test = require('node:test');
const assert = require('node:assert');
const { parseRules, applyRules } = require('../src/transform');

const idp = { username: ['bob'], email: ['Bob@Example.com'], department: ['Eng Ops'], groups: ['a', 'b'] };
const run = (text, start = []) => {
  const { rules, errors } = parseRules(text);
  assert.deepEqual(errors, []);
  const attrs = new Map(start);
  const runtime = applyRules(rules, attrs, (k) => idp[k] || []);
  return { attrs: Object.fromEntries(attrs), runtime };
};

test('lower/upper/trim map over every value', () => {
  assert.deepEqual(run('mail = lower(email)\nU = upper(groups)').attrs, { mail: ['bob@example.com'], U: ['A', 'B'] });
});

test('SAML attributes shadow IdP attributes of the same name', () => {
  assert.deepEqual(run('email = lower(email)', [['email', ['X@Y.Z']]]).attrs, { email: ['x@y.z'] });
});

test('concat, replace, extract, split, substring, coalesce, join', () => {
  const { attrs } = run([
    'upn = concat(username, "@corp.example")',
    'dept = replace(department, "^Eng", "Engineering")',
    'domain = extract(email, "@(.+)$")',
    'local = split(email, "@", 0)',
    'tld = split(email, ".", -1)',
    'ini = substring(username, 0, 1)',
    'pick = coalesce(missing, username)',
    'all = join(groups, ";")',
  ].join('\n'));
  assert.deepEqual(attrs, {
    upn: ['bob@corp.example'], dept: ['Engineering Ops'], domain: ['Example.com'], local: ['Bob'], tld: ['com'],
    ini: ['b'], pick: ['bob'], all: ['a;b'],
  });
});

test('an empty result removes the attribute, and drop() removes explicitly', () => {
  assert.deepEqual(run('x = missing\ny = drop()', [['x', ['1']], ['y', ['2']]]).attrs, {});
});

test('syntax errors are reported with line numbers; comments and blanks are skipped', () => {
  const { errors } = parseRules('# note\n\nok = lower(email)\nbad = nope(x)\nalso bad\nr = replace(a, "(", "b")\nq = lower()');
  assert.equal(errors.length, 4);
  assert.match(errors[0], /^Line 4: unknown function "nope"/);
  assert.match(errors[1], /^Line 5: expected "attribute = expression"/);
  assert.match(errors[2], /^Line 6: invalid regular expression/);
  assert.match(errors[3], /^Line 7: lower\(\) takes 1 argument/);
});

test('runtime errors skip only the failing rule', () => {
  const { rules } = parseRules('a = substring(email, "x")\nb = lower(email)');
  const attrs = new Map();
  const errors = applyRules(rules, attrs, (k) => idp[k] || []);
  assert.equal(errors.length, 1);
  assert.deepEqual(attrs.get('b'), ['bob@example.com']);
});
