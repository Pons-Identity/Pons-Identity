const crypto = require('crypto');

// RADIUS packets (RFC 2865, with Message-Authenticator from RFC 3579 and tunnel attributes from RFC 2868): decoding what a
// network device sends and encoding what we answer. Nothing here touches the database or the network.

const CODES = { ACCESS_REQUEST: 1, ACCESS_ACCEPT: 2, ACCESS_REJECT: 3, ACCOUNTING_REQUEST: 4, ACCOUNTING_RESPONSE: 5, ACCESS_CHALLENGE: 11 };

// The attributes this server reads or can send, by name. `kind` says how the value is encoded.
const ATTRIBUTES = {
  'User-Name': { type: 1, kind: 'text' },
  'User-Password': { type: 2, kind: 'octets' },
  'CHAP-Password': { type: 3, kind: 'octets' },
  'NAS-IP-Address': { type: 4, kind: 'ipv4' },
  'NAS-Port': { type: 5, kind: 'integer' },
  'Service-Type': { type: 6, kind: 'integer' },
  'Framed-Protocol': { type: 7, kind: 'integer' },
  'Filter-Id': { type: 11, kind: 'text' },
  'Reply-Message': { type: 18, kind: 'text' },
  'State': { type: 24, kind: 'octets' },
  'Class': { type: 25, kind: 'text' },
  'Session-Timeout': { type: 27, kind: 'integer' },
  'Idle-Timeout': { type: 28, kind: 'integer' },
  'Called-Station-Id': { type: 30, kind: 'text' },
  'Calling-Station-Id': { type: 31, kind: 'text' },
  'NAS-Identifier': { type: 32, kind: 'text' },
  'NAS-Port-Type': { type: 61, kind: 'integer' },
  'Tunnel-Type': { type: 64, kind: 'tagged-integer' },
  'Tunnel-Medium-Type': { type: 65, kind: 'tagged-integer' },
  'Tunnel-Private-Group-Id': { type: 81, kind: 'text' },
  'EAP-Message': { type: 79, kind: 'octets' },
  'Message-Authenticator': { type: 80, kind: 'octets' },
};
const BY_TYPE = Object.fromEntries(Object.entries(ATTRIBUTES).map(([name, a]) => [a.type, name]));

const HEADER = 20;
const MAX_LENGTH = 4096;
const MA = ATTRIBUTES['Message-Authenticator'].type;

class PacketError extends Error {}

/** Reads a datagram. Returns { code, id, authenticator, attributes: [{ type, name, value }], raw } or throws PacketError. */
function parse(buf) {
  if (buf.length < HEADER || buf.length > MAX_LENGTH) throw new PacketError('bad length');
  const length = buf.readUInt16BE(2);
  if (length < HEADER || length > buf.length) throw new PacketError('bad length');
  const attributes = [];
  for (let i = HEADER; i < length;) {
    if (i + 2 > length) throw new PacketError('truncated attribute');
    const type = buf[i];
    const len = buf[i + 1];
    if (len < 2 || i + len > length) throw new PacketError('bad attribute length');
    attributes.push({ type, name: BY_TYPE[type] || `Attribute-${type}`, value: buf.subarray(i + 2, i + len) });
    i += len;
  }
  return { code: buf[0], id: buf[1], authenticator: buf.subarray(4, 20), attributes, raw: buf.subarray(0, length) };
}

const first = (packet, name) => (packet.attributes.find((a) => a.name === name) || {}).value;
const text = (value) => (value === undefined ? undefined : value.toString('utf8'));

/** The bytes of one attribute's value for a name and a JS value (a string or number). */
function encodeValue(name, value) {
  const def = ATTRIBUTES[name];
  if (!def) throw new PacketError(`Unknown attribute ${name}`);
  switch (def.kind) {
    case 'integer': { const b = Buffer.alloc(4); b.writeUInt32BE(Number(value) >>> 0); return b; }
    case 'tagged-integer': { const b = Buffer.alloc(4); b.writeUInt32BE(Number(value) & 0xffffff); b[0] = 0; return b; } // tag 0 (unused), then 3 bytes
    case 'ipv4': return Buffer.from(String(value).split('.').map(Number));
    case 'octets': return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'hex');
    default: return Buffer.from(String(value), 'utf8');
  }
}

// An attribute's value is at most 253 bytes; longer text is split across several attributes of the same type.
function attributeBytes(name, value) {
  const def = ATTRIBUTES[name];
  const body = Buffer.isBuffer(value) ? value : encodeValue(name, value);
  const out = [];
  for (let i = 0; i < Math.max(body.length, 1); i += 253) {
    const part = body.subarray(i, i + 253);
    out.push(Buffer.concat([Buffer.from([def.type, part.length + 2]), part]));
  }
  return Buffer.concat(out);
}

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const hmacMd5 = (secret, data) => crypto.createHmac('md5', secret).update(data).digest();

/** Decodes a User-Password attribute: 16-byte blocks, each XORed with MD5(secret + previous cipher block or the request authenticator). */
function decryptPassword(encrypted, secret, requestAuthenticator) {
  if (!encrypted.length || encrypted.length % 16 !== 0 || encrypted.length > 128) throw new PacketError('bad User-Password');
  const out = [];
  let prev = requestAuthenticator;
  for (let i = 0; i < encrypted.length; i += 16) {
    const block = encrypted.subarray(i, i + 16);
    const key = md5(Buffer.from(secret), prev);
    out.push(Buffer.from(block.map((b, j) => b ^ key[j])));
    prev = block;
  }
  const plain = Buffer.concat(out);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  return plain.subarray(0, end).toString('utf8');
}

/** Encrypts a password the way a device does (used by tests and the "test sign-in" button). */
function encryptPassword(password, secret, requestAuthenticator) {
  const raw = Buffer.from(password, 'utf8');
  const padded = Buffer.concat([raw, Buffer.alloc((16 - (raw.length % 16)) % 16 || (raw.length === 0 ? 16 : 0))]);
  const out = [];
  let prev = requestAuthenticator;
  for (let i = 0; i < padded.length; i += 16) {
    const key = md5(Buffer.from(secret), prev);
    const block = Buffer.from(padded.subarray(i, i + 16).map((b, j) => b ^ key[j]));
    out.push(block);
    prev = block;
  }
  return Buffer.concat(out);
}

/** Does the request's Message-Authenticator (if it has one) check out? Returns 'absent', 'valid' or 'invalid'. */
function checkMessageAuthenticator(packet, secret) {
  const attr = packet.attributes.find((a) => a.type === MA);
  if (!attr) return 'absent';
  if (attr.value.length !== 16) return 'invalid';
  // Find where the value sits in the raw packet, zero it, and sign the whole packet.
  const copy = Buffer.from(packet.raw);
  let offset = HEADER;
  while (offset < copy.length) {
    if (copy[offset] === MA) { copy.fill(0, offset + 2, offset + 18); break; }
    offset += copy[offset + 1];
  }
  const want = hmacMd5(Buffer.from(secret), copy);
  return crypto.timingSafeEqual(want, attr.value) ? 'valid' : 'invalid';
}

/**
 * An answer to `request`. `attributes` is [[name, value], ...]. When `signed` the Message-Authenticator is included (RFC 3579
 * says to answer in kind when the request had one). The Response Authenticator is computed last.
 */
function respond(request, code, attributes, secret, { signed = false } = {}) {
  const body = [];
  for (const [name, value] of attributes) body.push(attributeBytes(name, value));
  if (signed) body.push(Buffer.concat([Buffer.from([MA, 18]), Buffer.alloc(16)]));
  const attrs = Buffer.concat(body);
  const header = Buffer.alloc(HEADER);
  header[0] = code;
  header[1] = request.id;
  header.writeUInt16BE(HEADER + attrs.length, 2);
  request.authenticator.copy(header, 4); // the request's, while the Message-Authenticator is signed
  let packet = Buffer.concat([header, attrs]);
  if (signed) {
    const at = HEADER + attrs.length - 16;
    hmacMd5(Buffer.from(secret), packet).copy(packet, at);
  }
  md5(packet.subarray(0, 4), request.authenticator, packet.subarray(HEADER), Buffer.from(secret)).copy(packet, 4);
  return packet;
}

/** Builds an Access-Request as a device would send it (for tests and the console's test button). */
function buildRequest({ id = 1, attributes, secret, authenticator = crypto.randomBytes(16), signed = true }) {
  const body = attributes.map(([name, value]) => attributeBytes(name, value));
  if (signed) body.push(Buffer.concat([Buffer.from([MA, 18]), Buffer.alloc(16)]));
  const attrs = Buffer.concat(body);
  const header = Buffer.alloc(HEADER);
  header[0] = CODES.ACCESS_REQUEST;
  header[1] = id;
  header.writeUInt16BE(HEADER + attrs.length, 2);
  authenticator.copy(header, 4);
  const packet = Buffer.concat([header, attrs]);
  if (signed) hmacMd5(Buffer.from(secret), packet).copy(packet, packet.length - 16);
  return { packet, authenticator };
}

/** Does a response (from our server) carry a valid Response Authenticator for the request authenticator? */
function verifyResponse(response, requestAuthenticator, secret) {
  const check = Buffer.from(response);
  requestAuthenticator.copy(check, 4);
  const want = md5(check.subarray(0, 4), requestAuthenticator, check.subarray(HEADER), Buffer.from(secret));
  return crypto.timingSafeEqual(want, response.subarray(4, 20));
}

module.exports = { CODES, ATTRIBUTES, PacketError, parse, first, text, decryptPassword, encryptPassword, checkMessageAuthenticator, respond, buildRequest, verifyResponse };
