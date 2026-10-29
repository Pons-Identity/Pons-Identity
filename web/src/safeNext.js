// Where the browser may go after sign-in: a path on this site and nothing else (mirrors src/safe-redirect.js on the server).
// `/\evil.example` is refused because browsers read a backslash as a slash, and control characters because URL parsers drop them.
const BASE = 'http://site.invalid';

export function safeNext(value, fallback = '/') {
  if (typeof value !== 'string' || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    if (new URL(value, BASE).origin !== BASE) return fallback;
  } catch {
    return fallback;
  }
  return value;
}
