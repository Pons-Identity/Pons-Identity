const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Reads a downloaded release (.zip, .tar.gz, .tgz or .tar) into a new, empty directory, with no outside tools. Only plain files
// and folders come out: a link, a device, an absolute path, or a name that climbs out with ".." is refused, and the totals are
// capped, so an archive cannot write anywhere but the directory it was given or fill the disk.

const MAX_ENTRIES = 50000;
const MAX_TOTAL = 1024 * 1024 * 1024;

class ArchiveError extends Error {}

function safeTarget(dest, name) {
  const clean = String(name).replace(/\\/g, '/');
  if (clean.includes('\0') || path.posix.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) throw new ArchiveError(`The archive has an unsafe path: ${name}`);
  const parts = path.posix.normalize(clean).split('/').filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new ArchiveError(`The archive has an unsafe path: ${name}`);
  const target = path.join(dest, ...parts);
  if (target !== dest && !target.startsWith(dest + path.sep)) throw new ArchiveError(`The archive has an unsafe path: ${name}`);
  return target;
}

function limits() {
  let entries = 0; let total = 0;
  return (size) => {
    if (++entries > MAX_ENTRIES) throw new ArchiveError('The archive has too many files.');
    total += size;
    if (total > MAX_TOTAL) throw new ArchiveError('The archive is too large once unpacked.');
  };
}

function writeFile(dest, name, data, executable) {
  const target = safeTarget(dest, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data, { mode: executable ? 0o755 : 0o644 });
}

/* ----------------------------------- zip ----------------------------------- */

function extractZip(buf, dest) {
  const count = limits();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ArchiveError('This is not a zip file (no end-of-archive record).');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || p === 0xffffffff) throw new ArchiveError('Zip64 archives are not supported. Download the .tar.gz instead.');
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError('The zip file is damaged.');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new ArchiveError('Encrypted zip files are not supported.');
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    const type = unixMode & 0o170000;
    if (name.endsWith('/')) { count(0); fs.mkdirSync(safeTarget(dest, name), { recursive: true }); continue; }
    if (type && type !== 0o100000) throw new ArchiveError(`The archive contains a link or special file: ${name}`);
    count(usize);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new ArchiveError('The zip file is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) + 1 });
    else throw new ArchiveError(`Unsupported zip compression (method ${method}).`);
    if (data.length !== usize) throw new ArchiveError(`The zip file is damaged (${name}).`);
    writeFile(dest, name, data, (unixMode & 0o111) !== 0);
  }
}

/* ----------------------------------- tar ----------------------------------- */

const field = (b, from, len) => b.toString('utf8', from, from + len).replace(/\0.*$/s, '');
const octal = (b, from, len) => parseInt(field(b, from, len).trim() || '0', 8);

function paxPath(data) {
  let out = '';
  const text = data.toString('utf8');
  for (let i = 0; i < text.length;) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!len) break;
    const rec = text.slice(sp + 1, i + len - 1);
    if (rec.startsWith('path=')) out = rec.slice(5);
    i += len;
  }
  return out;
}

function extractTar(buf, dest) {
  const count = limits();
  let pos = 0;
  let longName = '';
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = field(h, 345, 155);
    let name = (prefix ? `${prefix}/` : '') + field(h, 0, 100);
    const body = buf.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') { longName = paxPath(body) || longName; continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (longName) { name = longName; longName = ''; }
    if (type === '5') { count(0); fs.mkdirSync(safeTarget(dest, name), { recursive: true }); continue; }
    if (type !== '0' && type !== '\0') throw new ArchiveError(`The archive contains a link or special file: ${name}`);
    count(size);
    writeFile(dest, name, body, (octal(h, 100, 8) & 0o111) !== 0);
  }
}

/** Unpacks `file` into the empty directory `dest`. */
function extract(file, dest) {
  const buf = fs.readFileSync(file);
  fs.mkdirSync(dest, { recursive: true });
  if (buf[0] === 0x50 && buf[1] === 0x4b) return extractZip(buf, dest);
  if (buf[0] === 0x1f && buf[1] === 0x8b) return extractTar(zlib.gunzipSync(buf, { maxOutputLength: MAX_TOTAL + 1024 * 1024 }), dest);
  if (buf.length > 262 && buf.toString('latin1', 257, 262) === 'ustar') return extractTar(buf, dest);
  throw new ArchiveError('This is not a .zip, .tar.gz or .tar file.');
}

module.exports = { extract, ArchiveError };
