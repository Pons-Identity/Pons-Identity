const crypto = require('crypto');
const auditLog = require('../audit');
const db = require('../db');
const { hashPassword } = require('../crypto');
const { newGuid } = require('../guid');
const { CATALOG } = require('./release-policy');

// Who a person from another institution is, and which local account (if any) they are. An upstream IdP is trusted only
// for the identifiers it is authoritative for: a scoped value counts only if its domain is a scope the IdP's own
// metadata publishes. Accounts are never matched by email, since any IdP in the federation could claim any address.

const SUBJECT_TYPES = ['pairwise-id', 'subject-id', 'persistent', 'eppn'];

const values = (attrs, id) => {
  const a = CATALOG[id];
  return [a.name, ...a.aliases].flatMap((n) => attrs[n] || []);
};
const first = (attrs, id) => values(attrs, id)[0] || '';

function inScope(value, scopes) {
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return false;
  const domain = value.slice(at + 1).toLowerCase();
  return scopes.some((s) => {
    if (!s.regexp) return s.value.toLowerCase() === domain;
    if (s.value.length > 200) return false;
    try {
      return new RegExp(`^(?:${s.value})$`, 'i').test(domain);
    } catch {
      return false;
    }
  });
}

/** The stable identifier to key the account on, or throws if the IdP released nothing it is authoritative for. */
function pickSubject({ nameId, attributes }, scopes) {
  const pairwise = first(attributes, 'pairwiseId');
  if (pairwise && inScope(pairwise, scopes)) return { type: 'pairwise-id', value: pairwise.toLowerCase() };
  const subjectId = first(attributes, 'subjectId');
  if (subjectId && inScope(subjectId, scopes)) return { type: 'subject-id', value: subjectId.toLowerCase() };
  if (nameId.format === 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' && nameId.value) return { type: 'persistent', value: nameId.value };
  const eptid = first(attributes, 'eptid');
  if (eptid) return { type: 'persistent', value: eptid };
  const eppn = first(attributes, 'eppn');
  if (eppn && inScope(eppn, scopes)) return { type: 'eppn', value: eppn.toLowerCase() };
  throw new Error('The identity provider did not release an identifier it is allowed to assert (pairwise-id, subject-id, a persistent ID, or an eduPersonPrincipalName in its own scope).');
}

/** Profile fields from the assertion. Scoped values are kept only when they are in the IdP's scope. */
function profileOf({ attributes }, scopes) {
  const eppn = first(attributes, 'eppn');
  return {
    eppn: eppn && inScope(eppn, scopes) ? eppn.toLowerCase() : '',
    email: first(attributes, 'mail'),
    displayName: first(attributes, 'displayName'),
    firstName: first(attributes, 'givenName'),
    lastName: first(attributes, 'sn'),
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9@._-]+/g, '-').slice(0, 80);

function uniqueUsername(profile, subject) {
  const base = slug(profile.eppn || `fed-${crypto.createHash('sha256').update(subject).digest('hex').slice(0, 12)}`);
  let name = base;
  for (let n = 2; db.get('SELECT 1 FROM users WHERE username = ?', name); n++) name = `${base}-${n}`;
  return name;
}

function createUser(profile, subject) {
  const display = profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  const id = Number(db.run(
    `INSERT INTO users (guid, username, password_hash, first_name, last_name, display_name, email, upn, mfa_enabled)
     VALUES (?,?,?,?,?,?,?,?,0)`,
    newGuid(), uniqueUsername(profile, subject),
    // Nobody can sign in with a password: the hash is of a value that is thrown away.
    hashPassword(crypto.randomBytes(32).toString('hex')),
    profile.firstName, profile.lastName, display, profile.email, profile.eppn).lastInsertRowid);
  return id;
}

const identityRow = (idp, type, subject) => db.get(
  'SELECT * FROM federated_identities WHERE idp_entity_id = ? AND subject_type = ? AND subject = ?', idp, type, subject);

/**
 * Resolve a validated assertion to a local user.
 * Returns { user } when the person may sign in, or { pending: true } when an administrator must accept them first.
 * Throws a user-facing Error when they are blocked or their account is disabled.
 */
function resolve({ idp, assertion, provisioning }) {
  const subject = pickSubject(assertion, idp.scopes);
  const profile = profileOf(assertion, idp.scopes);
  const display = profile.displayName || profile.eppn;
  const stored = JSON.stringify(assertion.attributes);
  const userError = (message) => Object.assign(new Error(message), { userFacing: true });

  let row = identityRow(idp.entityId, subject.type, subject.value);
  if (!row) {
    const auto = provisioning === 'auto';
    db.tx(() => {
      const userId = auto ? createUser(profile, subject.value) : null;
      db.run(
        `INSERT INTO federated_identities (idp_entity_id, subject_type, subject, user_id, status, provisioned, display_name, email, attributes)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        idp.entityId, subject.type, subject.value, userId, auto ? 'active' : 'pending', auto ? 1 : 0, display, profile.email, stored);
    });
    row = identityRow(idp.entityId, subject.type, subject.value);
    const created = row.user_id && db.get('SELECT id, username FROM users WHERE id = ?', row.user_id);
    auditLog.record({ category: 'user', action: auto ? 'identity.provisioned' : 'identity.pending',
      actor: created ? { type: 'user', id: created.id, name: created.username } : { type: 'anonymous', name: display || '' },
      target: { type: 'idp', name: idp.entityId }, detail: { subjectType: subject.type } });
  }
  if (row.status === 'blocked') throw userError('Sign-in from this account has been blocked by an administrator.');
  if (row.status === 'pending' || !row.user_id) {
    db.run('UPDATE federated_identities SET attributes = ?, display_name = ?, email = ? WHERE id = ?', stored, display, profile.email, row.id);
    return { pending: true };
  }

  const user = db.get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user || !user.active) throw userError('The account linked to this sign-in is disabled.');
  db.run("UPDATE federated_identities SET last_login_at = datetime('now'), attributes = ?, display_name = ?, email = ? WHERE id = ?",
    stored, display, profile.email, row.id);
  // Accounts this IdP created follow what it says about the person; accounts an administrator linked do not.
  if (row.provisioned) {
    const name = profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    db.run('UPDATE users SET first_name = ?, last_name = ?, display_name = ?, email = ? WHERE id = ?',
      profile.firstName || user.first_name, profile.lastName || user.last_name, name || user.display_name, profile.email || user.email, user.id);
  }
  return { user: db.get('SELECT * FROM users WHERE id = ?', user.id) };
}

/** Replay protection: false if this assertion was already used. Expired records are pruned on the way. */
function consumeAssertion(assertionId, expiresAt, now = Date.now()) {
  db.run('DELETE FROM used_assertions WHERE expires_at < ?', now);
  const r = db.run('INSERT OR IGNORE INTO used_assertions (assertion_id, expires_at) VALUES (?, ?)', assertionId, expiresAt);
  return r.changes === 1;
}

/* ------------------------------ Administration ------------------------------ */

const view = (r) => ({
  id: r.id, idp_entity_id: r.idp_entity_id, subject_type: r.subject_type, subject: r.subject, status: r.status,
  provisioned: Boolean(r.provisioned), display_name: r.display_name, email: r.email, first_seen_at: r.first_seen_at,
  last_login_at: r.last_login_at, user_id: r.user_id, username: r.username || null,
});

function list(status = '') {
  const where = ['pending', 'active', 'blocked'].includes(status) ? 'WHERE i.status = ?' : '';
  return db.all(
    `SELECT i.*, u.username FROM federated_identities i LEFT JOIN users u ON u.id = i.user_id ${where}
     ORDER BY CASE i.status WHEN 'pending' THEN 0 ELSE 1 END, i.first_seen_at DESC LIMIT 500`, ...(where ? [status] : [])).map(view);
}

/** Accept a pending sign-in: link it to an existing local user, or create a new account from what the IdP released. */
function approve(id, { userId = 0 } = {}) {
  const row = db.get('SELECT * FROM federated_identities WHERE id = ?', id);
  if (!row) throw new Error('No such federated identity.');
  if (userId) {
    const user = db.get('SELECT id FROM users WHERE id = ? AND active = 1', userId);
    if (!user) throw new Error('Choose an active local user to link to.');
    if (db.get('SELECT 1 FROM federated_identities WHERE user_id = ? AND idp_entity_id = ? AND id != ?', userId, row.idp_entity_id, id)) {
      throw new Error('That user is already linked to another identity from the same identity provider.');
    }
    db.run("UPDATE federated_identities SET user_id = ?, status = 'active', provisioned = 0 WHERE id = ?", userId, id);
    return;
  }
  const attributes = JSON.parse(row.attributes || '{}');
  // The username and UPN come from the subject only when it is a scope-checked eppn; other released values are not trusted for that.
  const profile = {
    eppn: row.subject_type === 'eppn' ? row.subject : '', email: first(attributes, 'mail'), displayName: first(attributes, 'displayName'),
    firstName: first(attributes, 'givenName'), lastName: first(attributes, 'sn'),
  };
  db.tx(() => {
    const newUser = createUser(profile, row.subject);
    db.run("UPDATE federated_identities SET user_id = ?, status = 'active', provisioned = 1 WHERE id = ?", newUser, id);
  });
}

function setStatus(id, status) {
  if (!['active', 'blocked', 'pending'].includes(status)) throw new Error('Invalid status.');
  const row = db.get('SELECT user_id FROM federated_identities WHERE id = ?', id);
  if (!row) throw new Error('No such federated identity.');
  if (status === 'active' && !row.user_id) throw new Error('Approve it first so it has an account.');
  db.run('UPDATE federated_identities SET status = ? WHERE id = ?', status, id);
}

const remove = (id) => db.run('DELETE FROM federated_identities WHERE id = ?', id);

module.exports = { pickSubject, profileOf, inScope, resolve, consumeAssertion, list, approve, setStatus, remove, SUBJECT_TYPES };
