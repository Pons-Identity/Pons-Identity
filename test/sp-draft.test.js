process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const sps = require('../src/sps');
const { seedAdmin } = require('../src/server');

seedAdmin();

test('a draft application may leave out its name and ACS URL', () => {
  const { data, errors } = sps.parseForm({ draft: true, nameid_format: 'emailAddress', nameid_source: 'email', sign_response: 'on' }, { draft: true });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(data.name, 'Generic SAML Service Provider');
  assert.deepStrictEqual(data.acs_urls, []);
});

test('a draft still rejects other invalid settings', () => {
  const { errors } = sps.parseForm({ nameid_format: 'emailAddress', sign_response: '' }, { draft: true });
  assert.ok(errors.includes('Enable at least one of "Sign response" or "Sign assertion".'));
});

test('a saved application still needs a name and ACS URL', () => {
  const { errors } = sps.parseForm({ nameid_format: 'emailAddress', nameid_source: 'email', sign_response: 'on' });
  assert.ok(errors.includes('Name is required.'));
  assert.ok(errors.includes('At least one ACS URL is required.'));
});

test('a draft gets IdP metadata as soon as it is created', () => {
  const { data } = sps.parseForm({ nameid_format: 'emailAddress', nameid_source: 'email', sign_response: 'on' }, { draft: true });
  const id = sps.createSp(data);
  const sp = sps.getSp(id);
  assert.ok(sp.cert_pem);
  assert.ok(sp.private_key_pem);
  assert.ok(sp.urls.entityId);
  db.run('DELETE FROM service_providers WHERE id = ?', id);
});
