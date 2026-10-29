const db = require('./db');
const appSettings = require('./app-settings');
const { safeFetchText, safeFetchBytes } = require('./safe-fetch');

// Fonts the IdP serves to every page. Files are kept in the database and served from this server, so a browser never contacts
// Google and the content security policy needs no outside hosts. Google is asked only about families in its own catalog, so an
// administrator cannot make the server fetch an arbitrary name. The featured families are the ones offered first.
const FEATURED = ['Inter', 'Roboto', 'Open Sans', 'Lato', 'Source Sans 3', 'Noto Sans', 'Montserrat', 'Poppins',
  'Merriweather', 'Nunito', 'Raleway', 'Work Sans', 'IBM Plex Sans', 'Playfair Display', 'Lora', 'Fira Sans'];
const CATALOG_URL = 'https://fonts.google.com/metadata/fonts';
const CSS_URL = 'https://fonts.googleapis.com/css2';
const FILE_HOST = 'fonts.gstatic.com';
const CATALOG_KEY = 'google_fonts';
// The catalog is refreshed from Google when someone looks at it and the copy kept here is more than a day old.
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE = 4 * 1024 * 1024;
const FAMILY_RE = /^[A-Za-z][A-Za-z0-9 .-]{0,59}$/;
const RANGE_RE = /^[Uu+0-9A-Fa-f?,\- ]+$/;
// Google serves WOFF2 to browsers it recognises.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
const CSS_FORMAT = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

// The network is behind this object so tests can answer it without reaching Google.
const net = { text: safeFetchText, bytes: safeFetchBytes };
function useNetwork(overrides) {
  Object.assign(net, overrides);
}

// A request the caller got wrong (400), or an upstream that failed (502). The routes answer with `status`.
const reject = (message, status = 400) => Object.assign(new Error(message), { status });

// Runs a network call and turns its failure into a 502, so the admin sees that Google was the problem.
async function upstream(what, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.status) throw e;
    throw reject(`Could not reach ${what} (${e.message}).`, 502);
  }
}

/** The sfnt or WOFF family of a font file, from its first bytes; null when it is not a font this IdP serves. */
function formatOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const tag = buf.subarray(0, 4).toString('latin1');
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'true' || buf.readUInt32BE(0) === 0x00010000) return 'ttf';
  return null;
}

/* ------------------------------- Google Fonts ------------------------------- */

function parseCatalog(text) {
  // The metadata is prefixed with an anti-hijacking guard line.
  const json = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
  return (Array.isArray(json.familyMetadataList) ? json.familyMetadataList : []).filter((f) => f && f.family)
    .map((f) => ({ family: String(f.family), category: f.category || '', variants: Array.isArray(f.variants) ? f.variants.map(String) : ['regular'] }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

async function refreshCatalog() {
  const { text } = await net.text(CATALOG_URL, { maxBytes: 8 * 1024 * 1024, timeoutMs: 20000 });
  const cache = { at: new Date().toISOString(), families: parseCatalog(text) };
  appSettings.write(CATALOG_KEY, cache);
  return cache;
}

const installedGoogle = () => new Set(db.all("SELECT DISTINCT family FROM font_files WHERE source = 'google'").map((r) => r.family.toLowerCase()));

/**
 * The common families and their variants, with whether each is installed here. Refreshed from Google at most once a day. If
 * Google cannot be reached, the copy kept here is shown with `stale` and an `error`; with no copy at all, it throws (502).
 */
async function googleCatalog() {
  const cached = appSettings.read(CATALOG_KEY);
  let out;
  if (cached && Date.now() - Date.parse(cached.at) < CATALOG_TTL_MS) {
    out = { ...cached, stale: false, error: null };
  } else {
    try {
      out = { ...(await upstream('Google Fonts', refreshCatalog)), stale: false, error: null };
    } catch (e) {
      if (!cached) throw e;
      out = { ...cached, stale: true, error: `${e.message} This list is from ${cached.at}.` };
    }
  }
  const have = installedGoogle();
  return { ...out, featured: FEATURED, families: out.families.map((f) => ({ ...f, installed: have.has(f.family.toLowerCase()) })) };
}

// A Google variant name ("regular", "700", "700italic") as a face.
function faceOf(variant) {
  if (variant === 'regular') return { italic: false, weight: 400 };
  if (variant === 'italic') return { italic: true, weight: 400 };
  const m = /^(\d{3})(italic)?$/.exec(variant);
  return m ? { italic: Boolean(m[2]), weight: Number(m[1]) } : null;
}

// The css2 `family` parameter for every variant listed: "Inter:ital,wght@0,400;0,700;1,400" or "Inter:wght@400;700".
function cssFamilyParam(name, variants) {
  const faces = new Map();
  for (const f of variants.map(faceOf).filter(Boolean)) faces.set(`${Number(f.italic)},${f.weight}`, f);
  if (!faces.size) faces.set('0,400', { italic: false, weight: 400 });
  const list = [...faces.values()].sort((a, b) => (Number(a.italic) - Number(b.italic)) || (a.weight - b.weight));
  const axes = list.some((f) => f.italic)
    ? `ital,wght@${list.map((f) => `${Number(f.italic)},${f.weight}`).join(';')}`
    : `wght@${list.map((f) => f.weight).join(';')}`;
  return `${name.replace(/ /g, '+')}:${axes}`;
}

// The @font-face blocks in a css2 reply: one per subset (unicode-range) and style and weight.
function parseFaces(css) {
  const faces = [];
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const url = /url\((https:\/\/[^)\s]+)\)/.exec(body)?.[1];
    const weight = Number(/font-weight:\s*(\d{3})/.exec(body)?.[1]);
    if (!url || !weight) continue;
    faces.push({
      style: /font-style:\s*italic/.test(body) ? 'italic' : 'normal',
      weight,
      range: (/unicode-range:\s*([^;]+)/.exec(body)?.[1] || '').trim(),
      url,
    });
  }
  return faces;
}

/** Downloads a common Google family's files into this server. Reinstalling replaces the earlier download. Returns the family name. */
async function installGoogle(requested) {
  const entry = (await googleCatalog()).families.find((f) => f.family === requested);
  if (!entry) throw reject('That is not a Google Font.');
  const { text } = await upstream('Google Fonts', () => net.text(`${CSS_URL}?family=${cssFamilyParam(entry.family, entry.variants)}&display=swap`,
    { headers: { 'user-agent': BROWSER_UA }, maxBytes: 256 * 1024, timeoutMs: 20000 }));
  const faces = parseFaces(text).filter((f) => new URL(f.url).hostname === FILE_HOST);
  if (!faces.length) throw reject(`Google Fonts sent no files for ${entry.family}.`, 502);
  const files = [];
  for (const f of faces) {
    const { body } = await upstream('Google Fonts', () => net.bytes(f.url, { maxBytes: MAX_FILE, timeoutMs: 20000 }));
    const format = formatOf(body);
    if (!format) throw reject(`Google Fonts sent a file for ${entry.family} that is not a font.`, 502);
    files.push({ ...f, body, format });
  }
  const name = canonical(entry.family);
  db.tx(() => {
    db.run("DELETE FROM font_files WHERE family = ? COLLATE NOCASE AND source = 'google'", name);
    for (const f of files) store({ family: name, style: f.style, weight: f.weight, range: f.range, format: f.format, source: 'google', data: f.body });
  });
  return name;
}

/* ------------------------------- Uploaded fonts ------------------------------- */

/**
 * Adds one font file to a family: its style ("normal" or "italic") and weight (100 to 900) say which face it is, so a family
 * can hold Regular, Bold, Italic and Bold Italic files. A file for a face that is already there replaces it. Returns the family name.
 */
function uploadFace({ family, style, weight, name, data }) {
  const requested = String(family || '').trim();
  if (!FAMILY_RE.test(requested)) throw reject('A font family needs a name of 1 to 60 letters, digits, spaces, dots or dashes.');
  if (!['normal', 'italic'].includes(style)) throw reject('Choose upright or italic for each font file.');
  if (!Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100) throw reject('Choose a weight from 100 to 900, in steps of 100, for each font file.');
  if (!Buffer.isBuffer(data) || !data.length) throw reject('Choose a font file to upload.');
  const label = String(name || 'The font file').slice(0, 120);
  if (data.length > MAX_FILE) throw reject(`${label} is larger than 4 MB.`, 413);
  const format = formatOf(data);
  if (!format) throw reject(`${label} is not a WOFF2, WOFF, TrueType or OpenType font.`);
  const canon = canonical(requested);
  store({ family: canon, style, weight, range: '', format, source: 'upload', data });
  return canon;
}

// Family names are matched without regard to case, and each family keeps the spelling it was first given.
function canonical(name) {
  return db.get('SELECT family FROM font_files WHERE family = ? COLLATE NOCASE LIMIT 1', name)?.family || name;
}

function store({ family, style, weight, range, format, source, data }) {
  db.run(`INSERT INTO font_files (family, style, weight, unicode_range, format, source, data, created_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(family, style, weight, unicode_range) DO UPDATE SET format = excluded.format, source = excluded.source,
    data = excluded.data, created_at = excluded.created_at`,
  family, style, weight, range, format, source, data, new Date().toISOString());
}

/** Removes a family and every file in it. Returns its name, or null when there is no such family. */
function removeFamily(requested) {
  const row = db.get('SELECT family FROM font_files WHERE family = ? COLLATE NOCASE LIMIT 1', requested);
  if (!row) return null;
  db.run('DELETE FROM font_files WHERE family = ? COLLATE NOCASE', requested);
  return row.family;
}

/**
 * Removes one face (a style and weight) of a family, whatever its subsets. Returns the families that no longer have any faces,
 * or null when that face is not installed.
 */
function removeFace(requested, style, weight) {
  const row = db.get('SELECT family FROM font_files WHERE family = ? COLLATE NOCASE LIMIT 1', requested);
  if (!row) return null;
  const { changes } = db.run('DELETE FROM font_files WHERE family = ? COLLATE NOCASE AND style = ? AND weight = ?', requested, style, weight);
  if (!changes) return null;
  return [row.family].filter((f) => !installedNames().has(f.toLowerCase()));
}

/**
 * Removes the Google Fonts that are not `keep` (the system font; '' for the browser default). Uploaded fonts are never removed
 * this way. Returns the families that were removed entirely.
 */
function pruneGoogle(keep = '') {
  const kept = String(keep || '').toLowerCase();
  const unused = db.all("SELECT DISTINCT family FROM font_files WHERE source = 'google'").map((r) => r.family)
    .filter((f) => f.toLowerCase() !== kept);
  db.tx(() => {
    for (const f of unused) db.run("DELETE FROM font_files WHERE family = ? COLLATE NOCASE AND source = 'google'", f);
  });
  return unused.filter((f) => !installedNames().has(f.toLowerCase()));
}

// Family names that have at least one face, in lower case.
const installedNames = () => new Set(db.all('SELECT DISTINCT family FROM font_files').map((r) => r.family.toLowerCase()));

/**
 * After families are removed: if the system font was one of them, it is cleared, so the branding never names a font that is gone.
 */
function forgetRemoved(removed) {
  const b = appSettings.branding();
  if (b.fontFamily && removed.some((f) => f.toLowerCase() === b.fontFamily.toLowerCase())) {
    appSettings.saveBranding({ ...b, fontFamily: '' });
  }
}

/** Every installed family, with the faces it has (one entry per style and weight, whatever its subsets). */
function installed() {
  const rows = db.all('SELECT family, style, weight, source FROM font_files ORDER BY family COLLATE NOCASE, style, weight');
  const out = [];
  for (const r of rows) {
    let f = out[out.length - 1];
    if (!f || f.family !== r.family) out.push((f = { family: r.family, faces: [] }));
    if (!f.faces.some((x) => x.style === r.style && x.weight === r.weight)) f.faces.push({ style: r.style, weight: r.weight, source: r.source });
  }
  return out;
}

/**
 * The class name that sets a family, for use in the sign-in page's CSS and HTML: "Acme Sans" is `idp-font-acme-sans`. Kept the same
 * as the copy in web/src/components/fontClass.js.
 */
const fontClass = (family) => `idp-font-${String(family).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/**
 * The stylesheet for one family, or for every installed family when none is named: its @font-face rules (the browser downloads a
 * file only when text uses it) and a class per family. Empty when nothing matches, so a stale link does no harm.
 */
function stylesheet(requested = '') {
  const rows = requested
    ? db.all('SELECT id, family, style, weight, unicode_range, format FROM font_files WHERE family = ? COLLATE NOCASE ORDER BY style, weight, unicode_range', requested)
    : db.all('SELECT id, family, style, weight, unicode_range, format FROM font_files ORDER BY family COLLATE NOCASE, style, weight, unicode_range');
  const faces = rows.map((r) => {
    const range = r.unicode_range && RANGE_RE.test(r.unicode_range) ? ` unicode-range: ${r.unicode_range};` : '';
    return `@font-face { font-family: "${r.family}"; font-style: ${r.style}; font-weight: ${r.weight}; font-display: swap;`
      + ` src: url(/api/branding/font-files/${r.id}) format("${CSS_FORMAT[r.format]}");${range} }`;
  });
  const classes = [...new Set(rows.map((r) => r.family))]
    .map((f) => `.${fontClass(f)} { font-family: "${f}", system-ui, sans-serif; }`);
  return [...faces, ...classes].join('\n');
}

/** One stored file, for the public font-files route: { mime, data }, or null. */
function file(id) {
  const row = db.get('SELECT format, data FROM font_files WHERE id = ?', id);
  return row ? { mime: MIME[row.format], data: row.data } : null;
}

module.exports = {
  FEATURED, googleCatalog, installGoogle, uploadFace, removeFamily, removeFace, pruneGoogle, forgetRemoved, installed, stylesheet, fontClass, file,
  canonical, formatOf, useNetwork,
  parseCatalog, cssFamilyParam, parseFaces, reject,
};
