process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const { parseBranding, BRANDING_DEFAULTS } = require('../src/app-settings');

const base = { appName: 'Acme', primaryColor: '#1f5fbf', darkPrimaryColor: '#7cb4ff' };

test('the sign-in text sits below the card unless the footer is chosen', () => {
  assert.equal(BRANDING_DEFAULTS.loginNotice, '');
  assert.equal(BRANDING_DEFAULTS.loginNoticePlacement, 'below-card');
  const { data, errors } = parseBranding({ ...base, loginNotice: '  Call **the desk**.  ', loginNoticePlacement: 'footer' });
  assert.deepEqual(errors, []);
  assert.equal(data.loginNotice, 'Call **the desk**.');
  assert.equal(data.loginNoticePlacement, 'footer');
  assert.equal(parseBranding({ ...base }).data.loginNoticePlacement, 'below-card');
});

test('the sign-in text has a length limit and a known placement', () => {
  assert.match(parseBranding({ ...base, loginNotice: 'x'.repeat(2001) }).errors.join(' '), /2,000 characters/);
  assert.match(parseBranding({ ...base, loginNoticePlacement: 'sidebar' }).errors.join(' '), /below the card or in the footer/);
});

test('the panel, text color and alignment have defaults and known values', () => {
  assert.equal(BRANDING_DEFAULTS.loginNoticePanel, true);
  assert.equal(BRANDING_DEFAULTS.loginNoticeColor, 'white');
  assert.equal(BRANDING_DEFAULTS.loginNoticeAlign, 'center');
  const { data, errors } = parseBranding({ ...base, loginNotice: 'Hi', loginNoticePanel: false, loginNoticeColor: 'black', loginNoticeAlign: 'right' });
  assert.deepEqual(errors, []);
  assert.deepEqual([data.loginNoticePanel, data.loginNoticeColor, data.loginNoticeAlign], [false, 'black', 'right']);
  assert.match(parseBranding({ ...base, loginNoticeColor: 'red' }).errors.join(' '), /white or black/);
  assert.match(parseBranding({ ...base, loginNoticeAlign: 'justify' }).errors.join(' '), /center, left or right/);
});
