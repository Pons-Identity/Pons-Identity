const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const ipaddr = require('ipaddr.js');

const MAX_REDIRECTS = 3;

/**
 * True for anything that is not an ordinary public unicast address: loopback, private, link-local, CGNAT, multicast,
 * reserved, and the IPv6 forms that carry an IPv4 address (IPv4-mapped, NAT64, 6to4, Teredo). An address that does not parse
 * counts as non-public. ipaddr.js maps `::ffff:7f00:1` back to 127.0.0.1 before it is classified, which a string match cannot.
 */
function isPrivateAddress(addr) {
  let parsed;
  try { parsed = ipaddr.process(String(addr).replace(/^\[|\]$/g, '').replace(/%.*$/, '')); } catch { return true; }
  return parsed.range() !== 'unicast';
}

const refusal = (host) => new Error(`Refusing to fetch ${host}: it resolves to a non-public address.`);

// Used as the socket's `lookup`, so the address that is checked is the address that is connected to. Checking first and letting
// fetch resolve again would leave a window in which a DNS server could answer differently (rebinding).
function publicOnlyLookup(hostname, options, callback) {
  const opts = typeof options === 'object' && options !== null ? options : { family: options };
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return callback(refusal(hostname));
    if (opts.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

const DECODERS = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };

// One request to one URL with no redirect handling. Resolves { status, headers (lower-case names), body (Buffer, at most maxBytes) }.
function once(url, { method, headers, body, timeoutMs, maxBytes, allowPrivate, truncate = false }) {
  return new Promise((resolve, reject) => {
    if (!/^https?:$/.test(url.protocol)) return reject(new Error('URL must be http(s).'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) return reject(refusal(url.hostname));
    const data = body === undefined || body === null ? null : Buffer.from(body);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method,
      headers: { 'user-agent': 'PonsIdentity', accept: '*/*', ...headers, ...(data ? { 'content-length': data.length } : {}) },
      timeout: timeoutMs,
      ...(allowPrivate ? {} : { lookup: publicOnlyLookup }),
    });
    const timer = setTimeout(() => req.destroy(new Error('The request timed out.')), timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); fn(v); };
    req.on('timeout', () => req.destroy(new Error('The request timed out.')));
    req.on('error', (e) => done(reject, e));
    req.on('response', (res) => {
      const out = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
      const redirect = res.statusCode >= 300 && res.statusCode < 400 && out.location;
      if (redirect) { res.resume(); return done(resolve, { status: res.statusCode, headers: out, body: Buffer.alloc(0) }); }
      if (!truncate && Number(out['content-length']) > maxBytes) { res.destroy(); return done(reject, new Error('Response is too large.')); }
      const decode = DECODERS[String(out['content-encoding'] || '').toLowerCase()];
      const stream = decode ? res.pipe(decode()) : res;
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          stream.destroy();
          if (!truncate) return done(reject, new Error('Response is too large.'));
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          return done(resolve, { status: res.statusCode, headers: out, body: Buffer.concat(chunks) });
        }
        chunks.push(chunk);
        return undefined;
      });
      stream.on('end', () => done(resolve, { status: res.statusCode, headers: out, body: Buffer.concat(chunks) }));
      stream.on('error', (e) => done(reject, e));
      res.on('error', (e) => done(reject, e));
    });
    req.end(data);
  });
}

/**
 * Fetch a remote document for an admin-supplied URL: http(s) only, public addresses only (checked on every redirect hop,
 * at the moment of connecting), a timeout, and a hard size cap. Returns { status, text, headers } where headers.get(name)
 * reads a response header.
 * Set ALLOW_PRIVATE_FETCH=true to permit internal hosts (e.g. an on-prem metadata server).
 */
async function safeFetchText(rawUrl, { timeoutMs = 10000, maxBytes = 1024 * 1024, headers } = {}) {
  const allowPrivate = process.env.ALLOW_PRIVATE_FETCH === 'true';
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await once(url, { method: 'GET', headers, timeoutMs, maxBytes, allowPrivate });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(r.headers.location, url);
      continue;
    }
    if (!(r.status >= 200 && r.status < 300) && r.status !== 304) throw new Error(`HTTP ${r.status}`);
    return { status: r.status, text: r.body.toString('utf8'), headers: { get: (name) => r.headers[String(name).toLowerCase()] ?? null } };
  }
  throw new Error('Too many redirects.');
}

/**
 * Send one request to an admin-configured API (SMS, voice, email providers) under the same rules as safeFetchText:
 * http(s) only, public addresses only, a timeout, a size cap (a longer reply is cut off, not refused), and no redirects (a redirect would re-send credentials
 * and the body somewhere unchecked). Returns { status, ok, text }; it does not throw on an HTTP error status.
 */
async function safeRequest(rawUrl, { method = 'POST', headers, body, timeoutMs = 10000, maxBytes = 64 * 1024 } = {}) {
  const url = new URL(rawUrl);
  const r = await once(url, { method, headers, body, timeoutMs, maxBytes, allowPrivate: process.env.ALLOW_PRIVATE_FETCH === 'true', truncate: true });
  return { status: r.status, ok: r.status >= 200 && r.status < 300, text: r.body.toString('utf8') };
}

module.exports = { safeFetchText, safeRequest, isPrivateAddress };
