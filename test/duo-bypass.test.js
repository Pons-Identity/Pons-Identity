process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('../src/settings');
const appSettings = require('../src/app-settings');
const duo = require('../src/duo');

// The break-glass file turns Duo off whatever the console or config says, and removing it turns Duo back on at once.
test('a break-glass file next to the database turns Duo off, and removing it turns Duo back on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-bypass-'));
  const before = { ...settings };
  try {
    settings.duoBypassFile = path.join(dir, 'duo-disabled');
    settings.duoApiHost = 'api-test.duosecurity.com';
    settings.duoIntegrationKey = 'DIKEY';
    settings.duoSecretKey = 'secret';
    assert.equal(duo.enabled(), true);

    fs.writeFileSync(settings.duoBypassFile, '');
    assert.equal(duo.enabled(), false);
    const view = appSettings.duo();
    assert.equal(view.bypassed, true);
    assert.equal(view.source, 'bypass-file');
    assert.equal(view.secretKey, 'secret', 'the configured keys are kept, so the console still shows them');

    fs.unlinkSync(settings.duoBypassFile);
    assert.equal(duo.enabled(), true);
    assert.equal(appSettings.duo().bypassed, false);
  } finally {
    Object.assign(settings, before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the break-glass file sits next to the database by default', () => {
  assert.equal(path.basename(settings.duoBypassFile), 'duo-disabled');
});
