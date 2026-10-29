process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const fonts = require('../src/fonts');
const appSettings = require('../src/app-settings');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();

// Google, without the network: a catalog with two families, css2 replies that name gstatic files, and the file bytes.
const woff2 = (tag) => Buffer.concat([Buffer.from('wOF2'), Buffer.from(tag)]);
const GOOGLE = { catalogCalls: 0, cssUrls: [], down: false };
const catalog = ")]}'\n" + JSON.stringify({ familyMetadataList: [
  { family: 'Inter', category: 'Sans Serif', variants: ['regular', 'italic', '700', '700italic'] },
  { family: 'Lora', category: 'Serif', variants: ['regular', '400italic'] },
] });
const css = [
  '@font-face {\n  font-family: \'Inter\';\n  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/inter/a.woff2) format(\'woff2\');\n  unicode-range: U+0000-00FF, U+0131;\n}',
  '@font-face {\n  font-family: \'Inter\';\n  font-style: italic;\n  font-weight: 700;\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/inter/b.woff2) format(\'woff2\');\n}',
].join('\n');
fonts.useNetwork({
  text: async (url) => {
    if (String(url).startsWith('https://fonts.google.com/metadata/fonts')) {
      GOOGLE.catalogCalls++;
      if (GOOGLE.down) throw new Error('getaddrinfo ENOTFOUND');
      return { text: catalog };
    }
    GOOGLE.cssUrls.push(String(url));
    return { text: css };
  },
  bytes: async (url) => ({ body: woff2(String(url).split('/').pop()) }),
});

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

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
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: r.status, json, text, buf, headers: r.headers };
  };
  await request('/api/session');
  assert.equal((await request('/api/login', { method: 'POST', body: { username, password } })).status, 200);
  return request;
}

const FONT = woff2('bold-italic');
const upload = (admin, query, data = FONT) => admin(`/api/admin/settings/fonts?${query}`, { method: 'POST', body: data, type: 'application/octet-stream' });

test('the Google list is refreshed from Google when stale, and says which common families are installed', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const list = await admin('/api/admin/settings/google-fonts');
  assert.equal(list.status, 200);
  assert.equal(GOOGLE.catalogCalls, 1);
  assert.deepEqual(list.json.families.map((f) => f.family), ['Inter', 'Lora']);
  assert.equal(list.json.families[0].installed, false);
  assert.equal(list.json.stale, false);
  // A second look within a day uses the copy kept here.
  await admin('/api/admin/settings/google-fonts');
  assert.equal(GOOGLE.catalogCalls, 1);
});

test('a common Google family is downloaded with the axes it has, and only those names are accepted', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const r = await admin('/api/admin/settings/google-fonts/Inter', { method: 'POST' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.installed, 'Inter');
  const url = GOOGLE.cssUrls.at(-1);
  assert.match(url, /family=Inter:ital,wght@0,400;0,700;1,400;1,700&display=swap$/);
  const inter = r.json.families.find((f) => f.family === 'Inter');
  assert.deepEqual(inter.faces.map((f) => [f.style, f.weight, f.source]), [['italic', 700, 'google'], ['normal', 400, 'google']]);
  assert.equal((await admin('/api/admin/settings/google-fonts/Not%20In%20Catalog', { method: 'POST' })).status, 400);
  assert.equal((await admin('/api/admin/settings/google-fonts/Lora', { method: 'POST' })).status, 200);
});

test('when Google cannot be reached, the copy kept here is shown as stale, and nothing is installed without it', async () => {
  const admin = await signIn('admin', 'adminpass123');
  appSettings.write('google_fonts', { at: '2020-01-01T00:00:00.000Z', families: [{ family: 'Lora', category: 'Serif', variants: ['regular'] }] });
  GOOGLE.down = true;
  try {
    const list = await admin('/api/admin/settings/google-fonts');
    assert.equal(list.status, 200);
    assert.equal(list.json.stale, true);
    assert.match(list.json.error, /ENOTFOUND/);
    // Without the copy, the list cannot be shown at all.
    db.run("DELETE FROM settings WHERE key = 'google_fonts'");
    const none = await admin('/api/admin/settings/google-fonts');
    assert.equal(none.status, 502);
    assert.match(none.json.errors[0], /Could not reach Google Fonts/);
  } finally {
    GOOGLE.down = false;
  }
});

test('a bold italic file is stored as its own face, and the family CSS names that face', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const r = await upload(admin, 'family=Acme%20Sans&style=italic&weight=700&name=AcmeSans-BoldItalic.woff2');
  assert.equal(r.status, 200, r.text);
  const acme = r.json.families.find((f) => f.family === 'Acme Sans');
  assert.deepEqual(acme.faces, [{ style: 'italic', weight: 700, source: 'upload' }]);
  // Regular and bold upright added afterwards; re-uploading a face replaces it rather than adding a second.
  assert.equal((await upload(admin, 'family=acme%20sans&style=normal&weight=400&name=AcmeSans-Regular.woff2', woff2('regular'))).status, 200);
  assert.equal((await upload(admin, 'family=Acme%20Sans&style=normal&weight=700&name=AcmeSans-Bold.woff2', woff2('bold'))).status, 200);
  const again = await upload(admin, 'family=Acme%20Sans&style=italic&weight=700&name=AcmeSans-BoldItalic.woff2', woff2('bold-italic-2'));
  assert.equal(again.json.families.find((f) => f.family === 'Acme Sans').faces.length, 3);

  const css = await fetch(`${base}/api/branding/font.css?family=${encodeURIComponent('Acme Sans')}`);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  const text = await css.text();
  const blocks = [...text.matchAll(/@font-face \{ font-family: "Acme Sans"; font-style: (\w+); font-weight: (\d+);/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(blocks.sort(), ['italic 700', 'normal 400', 'normal 700']);
  assert.match(text, /format\("woff2"\)/);
});

test('uploaded font files are served with their type, cached for a year, and only fonts are accepted', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const css = await (await fetch(`${base}/api/branding/font.css?family=Acme%20Sans`)).text();
  const id = Number(/font-files\/(\d+)\) format\("woff2"\)/.exec(css)[1]);
  const file = await fetch(`${base}/api/branding/font-files/${id}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'font/woff2');
  assert.match(file.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/api/branding/font-files/999999`)).status, 404);

  assert.equal((await upload(admin, 'family=Bad&style=normal&weight=400&name=notes.txt', Buffer.from('hello world, not a font'))).status, 400);
  assert.equal((await upload(admin, 'family=Bad&style=oblique&weight=400&name=a.woff2')).status, 400);
  assert.equal((await upload(admin, 'family=Bad&style=normal&weight=450&name=a.woff2')).status, 400);
  assert.equal((await upload(admin, 'family=Bad%3Cscript&style=normal&weight=400&name=a.woff2')).status, 400);
  const big = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal((await upload(admin, 'family=Big&style=normal&weight=400&name=big.woff2', big)).status, 413);
});

test('the font list and the system font: only installed families can be the system font, and removing one clears it', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const saved = await admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#1f5fbf', fontFamily: 'acme SANS' } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.fontFamily, 'Acme Sans');
  assert.equal((await admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#1f5fbf', fontFamily: 'Nope' } })).status, 400);

  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.branding.fontFamily, 'Acme Sans');

  const removed = await admin('/api/admin/settings/fonts/Acme%20Sans', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  // Picking Acme Sans freed Inter and Lora, the Google Fonts that were no longer used.
  assert.deepEqual(removed.json.families, []);
  assert.equal(appSettings.branding().fontFamily, '');
  assert.equal((await admin('/api/admin/settings/fonts/Acme%20Sans', { method: 'DELETE' })).status, 404);
});

test('the stylesheet for a family that is not installed is empty, and fonts need branding.manage to change', async () => {
  const admin = await signIn('admin', 'adminpass123');
  assert.equal((await admin('/api/admin/settings/google-fonts/Inter', { method: 'POST' })).status, 200);
  const css = await fetch(`${base}/api/branding/font.css?family=Nothing`);
  assert.equal(await css.text(), '');
  const inter = await (await fetch(`${base}/api/branding/font.css?family=Inter`)).text();
  assert.match(inter, /font-style: italic; font-weight: 700;/);
  assert.match(inter, /unicode-range: U\+0000-00FF, U\+0131;/);

  const dup = await admin('/api/admin/settings/google-fonts/Lora', { method: 'POST' });
  assert.equal(dup.status, 200);
  assert.equal(fonts.canonical('lora'), 'Lora');
});

test('a single face can be deleted; picking another system font frees the unused Google Fonts; uploads stay until deleted', async () => {
  const admin = await signIn('admin', 'adminpass123');
  assert.equal((await upload(admin, 'family=Mine&style=normal&weight=400&name=Mine.woff2', woff2('mine-regular'))).status, 200);
  assert.equal((await upload(admin, 'family=Mine&style=italic&weight=700&name=Mine-BoldItalic.woff2', woff2('mine-bi'))).status, 200);

  const gone = await admin('/api/admin/settings/fonts/Mine/faces/italic/700', { method: 'DELETE' });
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.json.families.find((f) => f.family === 'Mine').faces, [{ style: 'normal', weight: 400, source: 'upload' }]);
  assert.equal((await admin('/api/admin/settings/fonts/Mine/faces/italic/700', { method: 'DELETE' })).status, 404);
  assert.equal((await admin('/api/admin/settings/fonts/Mine/faces/oblique/700', { method: 'DELETE' })).status, 400);

  // Inter becomes the system font: Lora, the other Google Font here, is freed. Mine was uploaded, so it stays.
  const picked = await admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#1f5fbf', fontFamily: 'Inter' } });
  assert.equal(picked.status, 200, picked.text);
  assert.deepEqual((await admin('/api/admin/settings/fonts')).json.families.map((f) => f.family), ['Inter', 'Mine']);

  // Deleting the unused Google Fonts keeps the chosen one and the upload. Removing the system font clears it.
  const sweep = await admin('/api/admin/settings/google-fonts/unused?keep=Mine', { method: 'DELETE' });
  assert.deepEqual(sweep.json.removed, ['Inter']);
  assert.deepEqual(sweep.json.families.map((f) => f.family), ['Mine']);
  assert.equal(appSettings.branding().fontFamily, '');

  // An uploaded family is deleted in one go as well.
  assert.equal((await admin('/api/admin/settings/fonts/Mine', { method: 'DELETE' })).status, 200);
  assert.deepEqual((await admin('/api/admin/settings/fonts')).json.families, []);
});
