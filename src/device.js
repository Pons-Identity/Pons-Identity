const crypto = require('crypto');
const db = require('./db');
const { baseUrl } = require('./config');

// Recognizing a browser the person has signed in from before. A long-lived cookie holds a random id signed with the
// server's session secret, so it cannot be forged or guessed. It proves nothing about who is using the browser (a stolen
// password plus a fresh browser is exactly what it catches): it only lets a sign-in say "this browser is new to this account".
// The id is also never stored as is: logs keep a short hash of it.

const COOKIE = 'idp_did';
const MAX_AGE_MS = 400 * 24 * 3600 * 1000; // browsers cap cookies at about this long

function secret() {
  let row = db.get("SELECT value FROM settings WHERE key = 'session_secret'");
  if (!row) {
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)", crypto.randomBytes(32).toString('hex'));
    row = db.get("SELECT value FROM settings WHERE key = 'session_secret'");
  }
  return row.value;
}

const sign = (id) => crypto.createHmac('sha256', secret()).update(`device:${id}`).digest('base64url');
const hashId = (id) => crypto.createHash('sha256').update(`device-id:${id}`).digest('hex').slice(0, 12);

function readCookie(req) {
  const raw = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [id, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  if (!id || !sig || id.length > 64) return null;
  const want = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? id : null;
}

/** Middleware: sets req.deviceId (short hash) from a valid cookie, or '' when the browser has none. Issues nothing. */
function read(req, res, next) {
  const id = readCookie(req);
  req.deviceId = id ? hashId(id) : '';
  req.deviceIsNew = !id;
  next();
}

// The cookie goes after the session cookie in the response. Simple HTTP clients that keep only the first Set-Cookie header
// (scripts, test tools) then still keep their session.
function lastSetCookie(res) {
  const set = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() === 'set-cookie' && Array.isArray(value)) {
      value = [...value.filter((c) => !c.startsWith(`${COOKIE}=`)), ...value.filter((c) => c.startsWith(`${COOKIE}=`))];
    }
    return set(name, value);
  };
}

/** Called once a password has been accepted: gives a browser that has no device cookie one, and sets req.deviceId. */
function ensure(req, res) {
  if (req.deviceId) return;
  const id = crypto.randomBytes(18).toString('base64url');
  lastSetCookie(res);
  res.cookie(COOKIE, `${id}.${sign(id)}`, { httpOnly: true, sameSite: 'lax', secure: baseUrl.startsWith('https://'), maxAge: MAX_AGE_MS, path: '/' });
  req.deviceId = hashId(id);
}

module.exports = { read, ensure, hashId, COOKIE };
