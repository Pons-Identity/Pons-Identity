// Functions a new install starts with (see functions.js). Each is the body of an async function. Its inputs are a table: the key
// the caller passes, and the variable the body reads it from. They use only what the calling integration's scopes allow, and
// say which. They are added once, when the functions table is first created (db.js); edit or delete them freely.

module.exports = [
  {
    name: 'normalizeEmail',
    description: 'Trims and lower-cases an email address. Returns "" if what is left does not look like an address.',
    inputs: [{ name: 'email', variable: 'email' }],
    script: String.raw`const s = String(email ?? '').trim().toLowerCase();
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';`,
  },
  {
    name: 'fullName',
    description: 'Joins first_name and last_name into one name, leaving out a blank part.',
    inputs: [{ name: 'first_name', variable: 'first_name' }, { name: 'last_name', variable: 'last_name' }],
    script: String.raw`return [first_name, last_name].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');`,
  },
  {
    name: 'splitName',
    description: 'Splits a full name into { first_name, last_name }. The first word is the first name; the rest is the last name.',
    inputs: [{ name: 'display_name', variable: 'name' }],
    script: String.raw`const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
return { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') };`,
  },
  {
    name: 'slugify',
    description: 'Turns text into a lower-case, URL-safe slug: accents are removed and each run of other characters becomes one hyphen.',
    inputs: [{ name: 'text', variable: 'text' }],
    script: String.raw`return String(text ?? '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');`,
  },
  {
    name: 'toE164',
    description: 'Formats a phone number as +E.164 for text messages. A 10-digit number is taken as North American (+1). Returns "" if it cannot be read.',
    inputs: [{ name: 'phone', variable: 'phone' }],
    script: String.raw`const raw = String(phone ?? '').trim();
const digits = raw.replace(/\D/g, '');
if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
if (digits.length === 10) return '+1' + digits;
if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
return '';`,
  },
  {
    name: 'parseBoolean',
    description: 'Reads yes/no, true/false, y/n, 1/0 or on/off in any case. A blank value is false. Returns null for anything else, so a typo is not read as false.',
    inputs: [{ name: 'value', variable: 'value' }],
    script: String.raw`if (typeof value === 'boolean') return value;
const s = String(value ?? '').trim().toLowerCase();
if (['true', 'yes', 'y', '1', 'on'].includes(s)) return true;
if (['false', 'no', 'n', '0', 'off', ''].includes(s)) return false;
return null;`,
  },
  {
    name: 'dateInDays',
    description: 'The date that many days from now, as YYYY-MM-DD in UTC. Pass a number of days, e.g. 90.',
    inputs: [{ name: 'days', variable: 'days' }],
    script: String.raw`const count = Number(days);
if (!Number.isFinite(count)) throw new Error('dateInDays takes a number of days.');
return new Date(Date.now() + count * 86400000).toISOString().slice(0, 10);`,
  },
  {
    name: 'chunk',
    description: 'Splits a list into lists of at most `size` items. Takes { items, size }. Useful for sending work in batches.',
    inputs: [{ name: 'items', variable: 'items' }, { name: 'size', variable: 'size' }],
    script: String.raw`const n = Math.max(1, Math.floor(Number(size)) || 1);
const out = [];
for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
return out;`,
  },
  {
    name: 'uniqueBy',
    description: 'Keeps the first item for each value of a key. Takes { items, key }, e.g. { items: rows, key: "email" }.',
    inputs: [{ name: 'items', variable: 'items' }, { name: 'key', variable: 'key' }],
    script: String.raw`const seen = new Set();
return items.filter((item) => {
  const value = item?.[key];
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
});`,
  },
  {
    name: 'requestJson',
    description: 'Calls a web service and returns its JSON reply. Takes an HttpRequest, such as { url, method, headers, body }. Needs the http scope. Throws, with the status and the start of the reply, unless the service answers 2xx.',
    inputs: [{ name: 'request', variable: 'request' }],
    script: String.raw`const r = await http.request({ method: 'GET', ...request });
if (!r.ok) throw new Error((request.method || 'GET') + ' ' + request.url + ' answered ' + r.status + ': ' + r.text.slice(0, 200));
return r.json;`,
  },
  {
    name: 'restCall',
    description: 'Calls a REST API. Takes { baseUrl, path, method, query, headers, token, body }, e.g. { baseUrl: "https://api.example.net/v1", path: "/people/42", method: "PATCH", token: vars.HR_TOKEN, body: { active: false } }. The token is sent as a Bearer token. Returns { status, data }. Throws, with the method, path, status and start of the reply, unless the service answers 2xx. Needs the http scope.',
    inputs: [{ name: 'request', variable: 'request' }],
    script: String.raw`const { baseUrl, path, method, query, headers, token, body } = request || {};
const base = String(baseUrl ?? '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+/.test(base)) throw new Error('restCall needs a baseUrl that starts with https://, such as https://api.example.net/v1.');
const verb = String(method || 'GET').toUpperCase();
const pairs = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
const route = '/' + String(path ?? '').replace(/^\/+/, '');
const url = base + route + (pairs.length ? '?' + pairs.join('&') : '');
const h = { Accept: 'application/json', ...(headers || {}) };
if (token) h.Authorization = 'Bearer ' + token;
const r = await http.request({ url, method: verb, headers: h, body });
if (!r.ok) throw new Error(verb + ' ' + base + route + ' answered ' + r.status + ': ' + r.text.slice(0, 200));
return { status: r.status, data: r.json };`,
  },
  {
    name: 'findOrCreateUser',
    description: 'Finds the person with this email, or creates them. Takes { email, first_name, last_name, username?, groups?, generate_password? }; a new account gets a generated password unless generate_password is false, returned once as user.generated_password. Needs the users:read and users:write scopes. Returns { user, created }.',
    inputs: [
      { name: 'email', variable: 'email' },
      { name: 'first_name', variable: 'first_name' },
      { name: 'last_name', variable: 'last_name' },
      { name: 'username', variable: 'username' },
      { name: 'groups', variable: 'groups' },
      { name: 'generate_password', variable: 'generate_password' },
    ],
    script: String.raw`const found = await idp.users.find({ email });
if (found) return { user: found, created: false };
const user = await idp.users.create({
  username: username || (await idp.users.suggestUsername(first_name, last_name)),
  first_name,
  last_name,
  email,
  groups: groups || [],
  generate_password: generate_password !== false,
});
return { user, created: true };`,
  },
  {
    name: 'addToGroups',
    description: 'Adds one person to several local groups. Takes { user, groups }, where user is a username, GUID or User. Returns the names of the groups they were newly added to. Needs the groups:write scope.',
    inputs: [{ name: 'user', variable: 'user' }, { name: 'groups', variable: 'groups' }],
    script: String.raw`const added = [];
for (const group of groups || []) {
  if (await idp.groups.addMember(group, user)) added.push(group);
}
return added;`,
  },
  {
    name: 'sendEmail',
    description: 'Sends an email through the email provider in Settings → Messaging. Takes { to, subject, text }; subject defaults to "Message". Throws if the provider refuses it or the address was sent too many messages. Needs the messaging scope. Returns true.',
    inputs: [{ name: 'to', variable: 'to' }, { name: 'subject', variable: 'subject' }, { name: 'text', variable: 'text' }],
    script: String.raw`return await mail.send({ to, subject, text });`,
  },
  {
    name: 'sendSms',
    description: 'Sends a text message. Takes { to, text }, where to is a number such as +15551234567 (toE164 formats one). Throws if the provider refuses it or the number was sent too many messages. Needs the messaging scope. Returns true.',
    inputs: [{ name: 'to', variable: 'to' }, { name: 'text', variable: 'text' }],
    script: String.raw`return await sms.send({ to, text });`,
  },
];
