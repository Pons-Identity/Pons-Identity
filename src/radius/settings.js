const crypto = require('crypto');
const net = require('net');
const appSettings = require('../app-settings');

// RADIUS server settings: whether it listens, where, and the network devices (clients) allowed to ask it to sign people in.
// Each client has its own shared secret, kept in the settings table like the Duo secret key and never sent back to the console.

const KEY = 'radius';
const DEFAULTS = { enabled: false, port: 1812, bindAddress: '0.0.0.0', clients: [] };
const MAX_CLIENTS = 200;
const MIN_SECRET = 12;
const MFA_MODES = ['challenge', 'append'];

// What a client may be told to send back with an acceptance. VLAN is shorthand for the three tunnel attributes a switch or access
// point needs to put the person on a VLAN (Tunnel-Type=VLAN, Tunnel-Medium-Type=IEEE-802, Tunnel-Private-Group-Id).
const REPLY_ATTRIBUTES = {
  'Filter-Id': { kind: 'text', help: 'Names a filter or role on the device.' },
  'Class': { kind: 'text', help: 'An opaque value the device returns in accounting.' },
  'Reply-Message': { kind: 'text', help: 'A message shown to the person.' },
  'Session-Timeout': { kind: 'seconds', help: 'Seconds before the device ends the session.' },
  'Idle-Timeout': { kind: 'seconds', help: 'Seconds of silence before the device ends the session.' },
  'Service-Type': { kind: 'integer', help: 'For example 6 (administrative) or 7 (NAS prompt).' },
  VLAN: { kind: 'vlan', help: 'A VLAN number from 1 to 4094.' },
};

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** Lower-case address without an IPv4-mapped IPv6 prefix. */
const normalizeAddress = (a) => String(a || '').trim().toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');

// An address as a BigInt with its bit length, so IPv4 and IPv6 are compared the same way.
function toBits(address) {
  const a = normalizeAddress(address);
  if (net.isIPv4(a)) return { bits: 32, value: a.split('.').reduce((n, o) => (n << 8n) + BigInt(o), 0n) };
  if (net.isIPv6(a)) {
    const [head, tail = ''] = a.split('::');
    const part = (s) => (s ? s.split(':') : []);
    const h = part(head); const t = part(tail);
    const groups = [...h, ...Array(a.includes('::') ? 8 - h.length - t.length : 0).fill('0'), ...t];
    return { bits: 128, value: groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
  }
  return null;
}

/** Parses "10.0.0.1", "10.0.0.0/24" or an IPv6 equivalent. Returns { bits, value, prefix } or null. */
function parseAddress(text_) {
  const [addr, len] = normalizeAddress(text_).split('/');
  const b = toBits(addr);
  if (!b) return null;
  const prefix = len === undefined ? b.bits : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (prefix < 0 || prefix > b.bits) return null;
  return { ...b, prefix };
}

function covers(parsed, address) {
  const b = toBits(address);
  if (!b || b.bits !== parsed.bits) return false;
  const shift = BigInt(parsed.bits - parsed.prefix);
  return (b.value >> shift) === (parsed.value >> shift);
}

/** The enabled client whose address covers `address`; the most specific range wins. */
function matchClient(clients, address) {
  let best = null; let bestPrefix = -1;
  for (const c of clients) {
    const p = parseAddress(c.address);
    if (p && covers(p, address) && p.prefix > bestPrefix) { best = c; bestPrefix = p.prefix; }
  }
  return best;
}

const clean = (c) => ({
  id: c.id, name: c.name, address: c.address, secret: c.secret, enabled: c.enabled !== false,
  requireMessageAuthenticator: c.requireMessageAuthenticator !== false,
  mfaMode: MFA_MODES.includes(c.mfaMode) ? c.mfaMode : 'challenge',
  groups: Array.isArray(c.groups) ? c.groups.map(Number).filter(Boolean) : [],
  attributes: Array.isArray(c.attributes) ? c.attributes : [],
});

const get = () => {
  const saved = appSettings.read(KEY) || {};
  return { ...DEFAULTS, ...saved, clients: (saved.clients || []).map(clean) };
};

/** What the console may see: every client's secret is replaced by whether one is set. */
const view = (cfg = get()) => ({
  ...cfg,
  clients: cfg.clients.map(({ secret, ...c }) => ({ ...c, secret_set: Boolean(secret) })),
  replyAttributes: Object.fromEntries(Object.entries(REPLY_ATTRIBUTES).map(([k, v]) => [k, v])),
  minSecret: MIN_SECRET,
});

/** Validates the submitted settings against the saved ones (a blank secret on an existing client keeps its secret). Returns { data, errors }. */
function parse(body, current = get()) {
  const errors = [];
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('The port must be a number from 1 to 65535 (RADIUS normally uses 1812).');
  const bindAddress = text(body.bindAddress) || DEFAULTS.bindAddress;
  if (!net.isIP(bindAddress)) errors.push('The listening address must be an IP address such as 0.0.0.0.');
  const list = Array.isArray(body.clients) ? body.clients : [];
  if (list.length > MAX_CLIENTS) errors.push(`At most ${MAX_CLIENTS} clients are allowed.`);
  const clients = [];
  const names = new Set(); const addresses = new Set();
  list.forEach((c, i) => {
    const label = text(c.name) || `Client ${i + 1}`;
    const old = current.clients.find((x) => x.id === c.id);
    const name = text(c.name);
    if (!name || name.length > 100) errors.push(`${label}: give the client a name of up to 100 characters.`);
    else if (names.has(name.toLowerCase())) errors.push(`${label}: another client has that name.`);
    names.add(name.toLowerCase());
    const address = text(c.address);
    if (!parseAddress(address)) errors.push(`${label}: the address must be an IP address or a range such as 10.0.0.0/24.`);
    else if (addresses.has(normalizeAddress(address))) errors.push(`${label}: another client has that address.`);
    addresses.add(normalizeAddress(address));
    let secret = typeof c.secret === 'string' ? c.secret : '';
    if (!secret && old) secret = old.secret;
    if (secret.length < MIN_SECRET) errors.push(`${label}: the shared secret needs at least ${MIN_SECRET} characters (longer is better; the device must use the same one).`);
    if (secret.length > 128) errors.push(`${label}: the shared secret can be at most 128 characters.`);
    const attributes = [];
    for (const a of Array.isArray(c.attributes) ? c.attributes : []) {
      const def = REPLY_ATTRIBUTES[a.attribute];
      const value = text(String(a.value ?? ''));
      if (!def) { errors.push(`${label}: ${a.attribute || 'an attribute'} cannot be sent.`); continue; }
      if (!value || value.length > 200) { errors.push(`${label}: ${a.attribute} needs a value of up to 200 characters.`); continue; }
      if (def.kind === 'seconds' && !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 2592000)) { errors.push(`${label}: ${a.attribute} is a number of seconds from 1 to 2,592,000.`); continue; }
      if (def.kind === 'integer' && !/^\d{1,9}$/.test(value)) { errors.push(`${label}: ${a.attribute} is a whole number.`); continue; }
      if (def.kind === 'vlan' && !(/^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 4094)) { errors.push(`${label}: a VLAN is a number from 1 to 4094.`); continue; }
      attributes.push({ attribute: a.attribute, value, group_id: a.group_id ? Number(a.group_id) : null });
    }
    clients.push({
      id: old ? old.id : crypto.randomBytes(6).toString('hex'), name, address, secret, enabled: c.enabled !== false,
      requireMessageAuthenticator: c.requireMessageAuthenticator !== false,
      mfaMode: MFA_MODES.includes(c.mfaMode) ? c.mfaMode : 'challenge',
      groups: Array.isArray(c.groups) ? [...new Set(c.groups.map(Number).filter(Boolean))] : [], attributes,
    });
  });
  if (body.enabled && !clients.some((c) => c.enabled)) errors.push('Add at least one client before turning RADIUS on: a device must be listed to be answered.');
  return { errors, data: { enabled: Boolean(body.enabled), port, bindAddress, clients } };
}

const save = (data) => appSettings.write(KEY, data);

module.exports = { get, view, parse, save, matchClient, parseAddress, normalizeAddress, REPLY_ATTRIBUTES, MFA_MODES, MIN_SECRET };
