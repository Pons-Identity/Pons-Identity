process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const fonts = require('../src/fonts');
const assets = require('../src/assets');
const appSettings = require('../src/app-settings');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// Real file signatures, padded out to a plausible size.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

async function signIn(username, password) {
  let cookie = '';
  const request = async (path, { method = 'GET', body, type = 'application/json' } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    if (body !== undefined) headers['content-type'] = type;
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: payload });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  await request('/api/session');
  assert.equal((await request('/api/login', { method: 'POST', body: { username, password } })).status, 200);
  return request;
}

const upload = (admin, name, data) => admin(`/api/admin/settings/assets?name=${encodeURIComponent(name)}`,
  { method: 'POST', body: data, type: 'application/octet-stream' });

test('images are kept by file name: PNG, JPEG, GIF and WebP by their contents; SVG and other files are refused', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const ok = await upload(admin, 'background.png', PNG);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.name, 'background.png');
  assert.equal((await upload(admin, 'photo.jpg', JPEG)).status, 200);
  assert.equal((await upload(admin, 'anim.gif', Buffer.from('GIF89a' + 'x'.repeat(20)))).status, 200);
  assert.equal((await upload(admin, 'pic.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]))).status, 200);

  assert.equal((await upload(admin, 'logo.svg', Buffer.from('<svg onload="x()"></svg>'))).status, 400);
  assert.equal((await upload(admin, 'notes.png', Buffer.from('not really a picture'))).status, 400);
  assert.equal((await upload(admin, '../escape.png', PNG)).status, 400);
  assert.equal((await upload(admin, 'huge.png', Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]))).status, 413);
  assert.deepEqual(assets.list().map((a) => a.name), ['anim.gif', 'background.png', 'photo.jpg', 'pic.webp']);
});

test('an uploaded image is served from its own address, cached for a year, with its type', async () => {
  const id = Number(assets.list().find((a) => a.name === 'background.png').url.split('/').pop());
  const r = await fetch(`${base}/api/branding/assets/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await r.arrayBuffer()).equals(PNG), true);

  // A new upload under the same name gets a new address, so nothing cached is served for it.
  const admin = await signIn('admin', 'adminpass123');
  await upload(admin, 'background.png', Buffer.concat([PNG, Buffer.from('v2')]));
  assert.notEqual(assets.list().find((a) => a.name === 'background.png').url, `/api/branding/assets/${id}`);
  assert.equal(assets.urlMap()['photo.jpg'].startsWith('/api/branding/assets/'), true);
});

test('the built-in page background is an uploaded image, drawn with blur, brightness and contrast that are checked', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const put = (extra) => admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#1f5fbf', ...extra } });

  assert.equal((await put({ loginBackground: 'missing.png' })).status, 400);
  assert.equal((await put({ loginBackground: 'photo.jpg', loginBackgroundBlur: 40 })).status, 400);
  assert.equal((await put({ loginBackground: 'photo.jpg', loginBackgroundBrightness: 10 })).status, 400);
  assert.equal((await put({ loginBackground: 'photo.jpg', loginBackgroundContrast: 200 })).status, 400);

  const saved = await put({ loginBackground: 'photo.jpg', loginBackgroundBlur: 6, loginBackgroundBrightness: 70, loginBackgroundContrast: 110 });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual([saved.json.loginBackground, saved.json.loginBackgroundBlur, saved.json.loginBackgroundBrightness, saved.json.loginBackgroundContrast], ['photo.jpg', 6, 70, 110]);

  // Left out, the numbers keep their defaults: no blur, full brightness and contrast.
  const bare = await put({ loginBackground: 'photo.jpg' });
  assert.deepEqual([bare.json.loginBackgroundBlur, bare.json.loginBackgroundBrightness, bare.json.loginBackgroundContrast], [0, 100, 100]);

  // Removing the image clears the background that used it.
  assert.equal((await admin('/api/admin/settings/assets/photo.jpg', { method: 'DELETE' })).status, 200);
  assert.equal(appSettings.branding().loginBackground, '');
  assert.equal((await admin('/api/admin/settings/assets/photo.jpg', { method: 'DELETE' })).status, 404);
});

test('the stylesheet names every installed font, with a class for each, and one family can still be asked for alone', async () => {
  const uploadFont = (admin, family, name) => admin(`/api/admin/settings/fonts?${new URLSearchParams({ family, style: 'normal', weight: '400', name })}`,
    { method: 'POST', body: Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(16)]), type: 'application/octet-stream' });
  const admin = await signIn('admin', 'adminpass123');
  assert.equal((await uploadFont(admin, 'Acme Sans', 'AcmeSans.woff2')).status, 200);
  assert.equal((await uploadFont(admin, 'Lumen 2', 'Lumen2.woff2')).status, 200);

  const all = await fetch(`${base}/api/branding/font.css`).then((r) => r.text());
  assert.match(all, /\.idp-font-acme-sans \{ font-family: "Acme Sans", system-ui, sans-serif; \}/);
  assert.match(all, /\.idp-font-lumen-2 \{ font-family: "Lumen 2"/);
  assert.match(all, /font-family: "Lumen 2"; font-style: normal; font-weight: 400/);
  assert.equal(fonts.fontClass('Source Sans 3'), 'idp-font-source-sans-3');

  const one = await fetch(`${base}/api/branding/font.css?family=${encodeURIComponent('Lumen 2')}`).then((r) => r.text());
  assert.doesNotMatch(one, /Acme Sans/);
  assert.match(one, /Lumen 2/);
});

test('the logo, wordmark and favicon are uploaded images: they are checked, resolved for the pages, and cleared when deleted', async () => {
  const admin = await signIn('admin', 'adminpass123');
  assert.equal((await upload(admin, 'square.png', PNG)).status, 200);
  assert.equal((await upload(admin, 'wide.png', PNG)).status, 200);
  assert.equal((await upload(admin, 'tab.png', PNG)).status, 200);
  const put = (extra) => admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#1f5fbf', ...extra } });

  assert.equal((await put({ logoImage: 'nope.png' })).status, 400);
  assert.equal((await put({ wordmarkImage: 'nope.png' })).status, 400);
  assert.equal((await put({ faviconImage: 'nope.png' })).status, 400);

  // The legacy logo upload is used only while no logo image is chosen.
  assert.equal((await put({ logo: 'data:image/png;base64,iVBORw0KGgo=' })).status, 200);
  assert.equal((await put({ logo: 'data:image/png;base64,iVBORw0KGgo=', logoImage: 'square.png', wordmarkImage: 'wide.png', faviconImage: 'tab.png' })).status, 200);
  const pub = appSettings.publicBranding();
  const url = (name) => assets.list().find((a) => a.name === name).url;
  assert.equal(pub.logoUrl, url('square.png'));
  assert.equal(pub.logo, 'data:image/png;base64,iVBORw0KGgo=', 'the legacy logo is left as it is for the pages that fall back to it');
  assert.equal(pub.wordmarkUrl, url('wide.png'));
  assert.equal(pub.faviconUrl, url('tab.png'));

  // Deleting an image clears the role that used it, and the others stay.
  assert.equal((await admin('/api/admin/settings/assets/tab.png', { method: 'DELETE' })).status, 200);
  const after = appSettings.branding();
  assert.equal(after.faviconImage, '');
  assert.equal(after.logoImage, 'square.png');
  assert.equal(appSettings.publicBranding().faviconUrl, '');
});

test('the sign-in logo and logotype are separate from the header ones', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const url = (name) => assets.list().find((a) => a.name === name).url;
  assert.equal((await upload(admin, 'login-logo.png', PNG)).status, 200);
  const put = await admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#1f5fbf', ...appSettings.branding(), logoImage: 'square.png', loginLogoImage: 'login-logo.png' } });
  assert.equal(put.status, 200, put.text);
  const pub = appSettings.publicBranding();
  assert.equal(pub.logoUrl, url('square.png'));
  assert.equal(pub.loginLogoUrl, url('login-logo.png'));
  assert.notEqual(pub.logoUrl, pub.loginLogoUrl);
});
