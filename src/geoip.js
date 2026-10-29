const fs = require('fs');
const net = require('net');
const path = require('path');
const maxmind = require('maxmind');
const appSettings = require('./app-settings');
const settings = require('./settings');

// Where an address is, and whose network it is, from MaxMind GeoLite2 (or compatible) database files on this server. Nothing
// is sent anywhere. Without databases every lookup returns an empty answer and the signals that need a place stay quiet.
//   City database  -> country, region, city, coordinates
//   ASN database   -> autonomous system number and organization
// Upload them (free, with a MaxMind account) on Settings → Risk, or give the paths of files kept elsewhere on the server. Uploads
// are kept in the data folder. To update, upload again or replace the files and save the settings (or restart): they are reopened then.

const KEY = 'geoip';
const UPLOADS = { city: { file: 'GeoLite2-City.mmdb', type: 'City' }, asn: { file: 'GeoLite2-ASN.mmdb', type: 'ASN' } };
let readers = { city: null, asn: null, cityPath: '', asnPath: '', cityMtime: 0, asnMtime: 0 };
let injected = null;
const cache = new Map();

class InvalidDatabase extends Error {}

const config = () => ({ cityPath: '', asnPath: '', ...(appSettings.read(KEY) || {}) });
const saveConfig = (c) => { appSettings.write(KEY, { cityPath: String(c.cityPath || '').trim(), asnPath: String(c.asnPath || '').trim() }); cache.clear(); };

async function openReader(file) {
  if (!file) return { reader: null, mtime: 0 };
  const mtime = fs.statSync(file).mtimeMs;
  return { reader: await maxmind.open(file), mtime };
}

/**
 * Keeps an uploaded database (`kind` is 'city' or 'asn') in the data folder and makes it the one in use. The file is checked
 * before it replaces anything: it must open, and must be the kind of database it is said to be. Returns the load status, as load().
 */
async function upload(kind, buf) {
  const up = UPLOADS[kind];
  if (!up) throw new InvalidDatabase('Unknown database.');
  let type = null;
  try { type = new maxmind.Reader(buf).metadata?.databaseType; } catch { /* not a database: reported below */ }
  if (!type) throw new InvalidDatabase('That is not a valid MaxMind database. Upload the .mmdb file itself, not the downloaded archive.');
  if (!String(type).includes(up.type)) throw new InvalidDatabase(`That is not a MaxMind ${up.type} database.`);
  const dir = path.join(path.dirname(path.resolve(settings.dbPath)), 'geoip');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, up.file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  saveConfig({ ...config(), [`${kind}Path`]: file });
  return load();
}

/** (Re)opens the configured files. Returns { city, asn } status strings; a bad path is reported, not thrown. */
async function load() {
  const c = config();
  const status = { city: '', asn: '' };
  cache.clear();
  for (const [kind, p] of [['city', c.cityPath], ['asn', c.asnPath]]) {
    try {
      const { reader, mtime } = await openReader(p);
      readers[kind] = reader; readers[`${kind}Path`] = p; readers[`${kind}Mtime`] = mtime;
      status[kind] = reader ? 'loaded' : 'not configured';
    } catch (e) {
      readers[kind] = null;
      status[kind] = `cannot open: ${e.code === 'ENOENT' ? 'file not found' : 'not a valid database'}`;
    }
  }
  return status;
}

function status() {
  const c = config();
  const meta = (r) => (r && r.metadata ? { type: r.metadata.databaseType, built: new Date(r.metadata.buildEpoch * 1000).toISOString().slice(0, 10) } : null);
  return { cityPath: c.cityPath, asnPath: c.asnPath, city: meta(readers.city), asn: meta(readers.asn), available: Boolean(injected || readers.city || readers.asn) };
}

// Private, loopback and link-local addresses have no place on the map.
function isLocal(ip) {
  if (!net.isIP(ip)) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd') || /^::ffff:(10|127|192\.168)\./.test(v);
}

const EMPTY = { country: '', country_name: '', region: '', city: '', lat: null, lon: null, asn: null, asn_org: '' };

/** Sets a function (ip) => geo, for tests and for sites that look places up some other way. null removes it. */
const inject = (fn) => { injected = fn; cache.clear(); };

function lookup(ip) {
  if (injected) return { ...EMPTY, ...(injected(ip) || {}) };
  if (!ip || isLocal(ip.replace(/^::ffff:/, ''))) return { ...EMPTY };
  if (cache.has(ip)) return cache.get(ip);
  const out = { ...EMPTY };
  try {
    const c = readers.city && readers.city.get(ip);
    if (c) {
      out.country = (c.country && c.country.iso_code) || '';
      out.country_name = (c.country && c.country.names && c.country.names.en) || '';
      out.region = (c.subdivisions && c.subdivisions[0] && c.subdivisions[0].names && c.subdivisions[0].names.en) || '';
      out.city = (c.city && c.city.names && c.city.names.en) || '';
      if (c.location && Number.isFinite(c.location.latitude)) { out.lat = c.location.latitude; out.lon = c.location.longitude; }
    }
    const a = readers.asn && readers.asn.get(ip);
    if (a) { out.asn = a.autonomous_system_number || null; out.asn_org = a.autonomous_system_organization || ''; }
  } catch { /* a malformed address or a damaged database means no answer */ }
  if (cache.size > 5000) cache.clear();
  cache.set(ip, out);
  return out;
}

module.exports = { load, upload, status, lookup, inject, config, saveConfig, isLocal, EMPTY, InvalidDatabase };
