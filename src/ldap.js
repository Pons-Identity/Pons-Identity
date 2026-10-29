const { Client } = require('ldapts');

// LDAP / Active Directory client used to federate sign-in. Passwords are never compared here: the user's
// own bind against the directory is the check. The flow is the usual search-then-bind:
//   1. bind as the service account (or anonymously) and find the user's entry with the configured filter;
//   2. bind again as that entry's DN with the password the user typed.

// Tests replace the client so no directory server is needed.
let clientFactory = (options) => new Client(options);
const setClientFactory = (fn) => { clientFactory = fn || ((options) => new Client(options)); };

class DirectoryError extends Error {}

/** RFC 4515 escaping for a value inserted into a search filter. */
function escapeFilterValue(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

const FILTER_TOKEN = /\{username\}/g;
const buildFilter = (template, username) => template.replace(FILTER_TOKEN, () => escapeFilterValue(username));

function clientOptions(cfg) {
  const url = new URL(cfg.url);
  const timeout = (cfg.timeoutSeconds || 10) * 1000;
  const tlsOptions = { rejectUnauthorized: cfg.rejectUnauthorized !== false };
  if (cfg.caCertificate) tlsOptions.ca = cfg.caCertificate;
  if (url.protocol === 'ldap:') tlsOptions.servername = url.hostname;
  return { url: cfg.url, timeout, connectTimeout: timeout, tlsOptions };
}

/** A connected client, upgraded with StartTLS when configured. Callers must unbind it. */
async function connect(cfg) {
  const client = clientFactory(clientOptions(cfg));
  try {
    if (cfg.startTls && new URL(cfg.url).protocol === 'ldap:') await client.startTLS(clientOptions(cfg).tlsOptions);
  } catch (e) {
    await client.unbind().catch(() => {});
    throw new DirectoryError(`TLS negotiation failed: ${e.message}`);
  }
  return client;
}

const unbind = (client) => client.unbind().catch(() => {});

async function bindService(client, cfg) {
  if (!cfg.bindDn) return;
  try {
    await client.bind(cfg.bindDn, cfg.bindPassword || '');
  } catch (e) {
    throw new DirectoryError(`The service account could not bind: ${e.message}`);
  }
}

/** The first value of an LDAP attribute (case-insensitive name), as text. Binary values are ignored. */
function firstValue(entry, name) {
  if (!name) return '';
  if (name.toLowerCase() === 'dn') return entry.dn || '';
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key === undefined ? undefined : entry[key];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' ? first : '';
}

const allValues = (entry, name) => {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === String(name).toLowerCase());
  const v = key === undefined ? [] : [].concat(entry[key]);
  return v.filter((x) => typeof x === 'string');
};

/** Map an LDAP entry onto Pons Identity user fields using the directory's attribute map. */
function mapEntry(entry, cfg) {
  const out = {};
  for (const [field, attr] of Object.entries(cfg.attributeMap || {})) out[field] = firstValue(entry, attr).trim();
  return out;
}

/** Group names from a membership attribute (e.g. memberOf): the first RDN value of each DN, or the raw value. */
function groupNames(entry, cfg) {
  if (!cfg.groupAttribute) return [];
  const names = allValues(entry, cfg.groupAttribute).map((v) => {
    const m = /^\s*[A-Za-z][\w-]*\s*=\s*((?:\\.|[^,+\\])+)/.exec(v);
    return (m ? m[1].replace(/\\(.)/g, '$1') : v).trim();
  });
  return [...new Set(names.filter(Boolean))];
}

function requestedAttributes(cfg) {
  const attrs = new Set(Object.values(cfg.attributeMap || {}).filter((a) => a && a.toLowerCase() !== 'dn'));
  if (cfg.groupAttribute) attrs.add(cfg.groupAttribute);
  return [...attrs];
}

/** Find one user's entry. Resolves to null when nobody (or more than one person) matches. */
async function findEntry(client, cfg, username) {
  const { searchEntries } = await client.search(cfg.baseDn, {
    scope: 'sub',
    filter: buildFilter(cfg.userFilter, username),
    attributes: requestedAttributes(cfg),
    sizeLimit: 2,
    timeLimit: cfg.timeoutSeconds || 10,
  }).catch((e) => {
    // Hitting the size limit still returns what was found on some servers; treat it as ambiguous.
    if (e && /size ?limit/i.test(`${e.name} ${e.message}`)) return { searchEntries: [{}, {}] };
    throw new DirectoryError(`The directory search failed: ${e.message}`);
  });
  if (searchEntries.length !== 1 || !searchEntries[0].dn) return null;
  return searchEntries[0];
}

const result = (entry, cfg) => ({ dn: entry.dn, attributes: { ...mapEntry(entry, cfg), distinguished_name: entry.dn }, groups: groupNames(entry, cfg) });

/**
 * Check a username and password against the directory.
 * Resolves to { dn, attributes, groups } on success and null when the credentials are wrong;
 * throws DirectoryError when the directory cannot be used.
 */
async function authenticate(cfg, username, password) {
  // An empty password makes many servers treat the bind as anonymous, which succeeds.
  if (!username || !password || typeof password !== 'string') return null;
  const search = await connect(cfg);
  let entry;
  try {
    await bindService(search, cfg);
    entry = await findEntry(search, cfg, username);
  } finally {
    await unbind(search);
  }
  if (!entry) return null;

  const user = await connect(cfg);
  try {
    await user.bind(entry.dn, password);
  } catch (e) {
    if (/InvalidCredentials|invalid credentials|49/i.test(`${e.name} ${e.message} ${e.code}`)) return null;
    throw new DirectoryError(`The directory rejected the sign-in attempt: ${e.message}`);
  } finally {
    await unbind(user);
  }
  return result(entry, cfg);
}

/** Look a user up without a password, for the console's connection test. */
async function lookup(cfg, username) {
  const client = await connect(cfg);
  try {
    await bindService(client, cfg);
    const entry = await findEntry(client, cfg, username);
    return entry && result(entry, cfg);
  } finally {
    await unbind(client);
  }
}

/** Bind the service account and read the search base. Throws DirectoryError describing what failed. */
async function testConnection(cfg) {
  const client = await connect(cfg);
  try {
    await bindService(client, cfg);
    try {
      await client.search(cfg.baseDn, { scope: 'base', filter: '(objectClass=*)', attributes: ['1.1'], sizeLimit: 1 });
    } catch (e) {
      throw new DirectoryError(`The search base could not be read: ${e.message}`);
    }
  } finally {
    await unbind(client);
  }
}

module.exports = {
  authenticate, lookup, testConnection, setClientFactory, escapeFilterValue, buildFilter, groupNames, mapEntry, DirectoryError,
  connect, bindService, unbind, firstValue, allValues, requestedAttributes,
};
