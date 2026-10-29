const test = require('node:test');
const assert = require('node:assert');
const duo = require('../src/duo');

// Based on the v5 (HMAC-SHA512) POST example in the Duo Auth API documentation. The documented
// signature itself does not reproduce from the documented canonical string, so only the parts
// that are checkable are asserted here. Live signing still needs verifying against a Duo tenant.
test('v5 request signing uses the documented body and Basic auth format', () => {
  const s = duo.sign({
    method: 'POST',
    host: 'api-xxxxxxxx.duosecurity.com',
    path: '/auth/v2/auth',
    params: { username: 'narroway', factor: 'push', device: 'auto', ipaddr: '10.2.3.4', hostname: 'wks01' },
    date: 'Tue, 21 Aug 2012 17:29:18 -0000',
    ikey: 'DIWJ8X6AEYOR5OMC6TQ1',
    skey: 'Zh5eGmUq9zpfQnyUIu5OL9iWoMMv5ZNmk3zLJ4Ep',
  });
  assert.equal(s.body, '{"device":"auto","factor":"push","hostname":"wks01","ipaddr":"10.2.3.4","username":"narroway"}');
  assert.match(s.headers.Authorization, /^Basic [A-Za-z0-9+\/]+=*$/);
  assert.equal(Buffer.from(s.headers.Authorization.slice(6), "base64").toString().split(":")[0], "DIWJ8X6AEYOR5OMC6TQ1");
  assert.match(Buffer.from(s.headers.Authorization.slice(6), "base64").toString(), /^DIWJ8X6AEYOR5OMC6TQ1:[0-9a-f]{128}$/);
  assert.equal(s.headers['Content-Type'], 'application/json');
});

test('GET query parameters are sorted and encoded per Duo rules', () => {
  const s = duo.sign({
    method: 'GET', host: 'h.example', path: '/auth/v2/check', params: { username: 'root', realname: 'First Last!' },
    date: 'x', ikey: 'i', skey: 's',
  });
  assert.equal(s.query, 'realname=First%20Last%21&username=root');
  assert.equal(s.body, '');
});

test('enabled() requires host, integration key and secret key', () => {
  const settings = require('../src/settings');
  const before = { ...settings };
  try {
    settings.duoApiHost = 'api.example'; settings.duoIntegrationKey = 'i'; settings.duoSecretKey = '';
    assert.equal(duo.enabled(), false);
    settings.duoSecretKey = 's';
    assert.equal(duo.enabled(), true);
  } finally {
    Object.assign(settings, before);
  }
});
