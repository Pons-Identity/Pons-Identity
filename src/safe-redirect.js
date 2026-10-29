// Where a browser may be sent after sign-in: a path on this site and nothing else. `/\evil.example` is refused too, because
// browsers read a backslash as a slash and so treat it as `//evil.example`, and so are control characters (tabs and newlines
// are dropped by URL parsers, which turns `/<TAB>/evil.example` into `//evil.example`).
const BASE = 'http://site.invalid';

function safeNext(value, fallback = '/') {
  if (typeof value !== 'string' || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    if (new URL(value, BASE).origin !== BASE) return fallback;
  } catch {
    return fallback;
  }
  return value;
}

module.exports = { safeNext };
