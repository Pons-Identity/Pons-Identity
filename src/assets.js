const db = require('./db');
const appSettings = require('./app-settings');

// Images an administrator uploads for the sign-in page: a background, a logo, pictures inside a custom layout. The page's HTML and
// CSS refer to them by file name (`<img src="image.png">`, `url('image.png')`); the browser is given each one's address on this
// server, which is by id, so a re-upload under the same name is never served from an old cache.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(png|jpe?g|gif|webp)$/i;
const MAX_IMAGE = 2 * 1024 * 1024;

const reject = (message, status = 400) => Object.assign(new Error(message), { status });

// The type from the file's first bytes. SVG is not accepted: it can carry scripts, and this server serves what it stores.
function typeOf(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const url = (id) => `/api/branding/assets/${id}`;

/** Stores an image under a file name. Uploading under a name already used replaces that image. Returns the name. */
function upload(name, data) {
  const file = String(name || '').trim();
  if (!NAME_RE.test(file)) throw reject('An image name uses letters, digits, dots, dashes and underscores, and ends in .png, .jpg, .gif or .webp.');
  if (!Buffer.isBuffer(data) || !data.length) throw reject('Choose an image to upload.');
  if (data.length > MAX_IMAGE) throw reject(`${file} is larger than 2 MB.`, 413);
  const mime = typeOf(data);
  if (!mime) throw reject(`${file} is not a PNG, JPEG, GIF or WebP image.`);
  // A new row, so the new upload has a new address.
  db.tx(() => {
    db.run('DELETE FROM site_assets WHERE name = ?', file);
    db.run('INSERT INTO site_assets (name, mime, data, created_at) VALUES (?,?,?,?)', file, mime, data, new Date().toISOString());
  });
  return file;
}

/** Every uploaded image: { name, url, mime, bytes }. */
function list() {
  return db.all('SELECT id, name, mime, length(data) AS bytes FROM site_assets ORDER BY name COLLATE NOCASE')
    .map((r) => ({ name: r.name, url: url(r.id), mime: r.mime, bytes: r.bytes }));
}

/** File name to address, for the page's HTML and CSS: `<img src="image.png">` is rewritten to the address of the image. */
function urlMap() {
  return Object.fromEntries(list().map((a) => [a.name, a.url]));
}

/**
 * Removes an image. A sign-in background that used it is cleared, so the page never refers to a missing image.
 * Returns false when there is no such image.
 */
function remove(name) {
  const { changes } = db.run('DELETE FROM site_assets WHERE name = ?', name);
  if (!changes) return false;
  // Every role that used the image is cleared, so no page refers to a missing file.
  const b = appSettings.branding();
  const cleared = { ...b };
  for (const [key] of appSettings.IMAGE_ROLES) if (b[key] === name) cleared[key] = '';
  appSettings.saveBranding(cleared);
  return true;
}

const exists = (name) => Boolean(db.get('SELECT 1 FROM site_assets WHERE name = ?', name));

/** One stored image for the public route: { mime, data }, or null. */
function file(id) {
  const row = db.get('SELECT mime, data FROM site_assets WHERE id = ?', id);
  return row ? { mime: row.mime, data: row.data } : null;
}

module.exports = { upload, list, urlMap, remove, exists, file, MAX_IMAGE };
