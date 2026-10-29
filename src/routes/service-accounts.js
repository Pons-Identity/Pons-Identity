const express = require('express');
const accounts = require('../service-accounts');
const auditLog = require('../audit');
const sftp = require('../files/sftp-server');

// Console routes for service accounts, mounted under /api/admin/service-accounts. They sit with people on the Users page, so
// they follow the same permissions: users.view to see them, users.manage to change them.

const who = (req) => auditLog.who(req.user);
const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });
const target = (a) => ({ type: 'service_account', id: a.id, name: a.username });

module.exports = function serviceAccountRoutes(need) {
  const router = express.Router();

  router.get('/', need('users.view'), (req, res) => res.json({ accounts: accounts.list() }));

  // `generate: true` makes a password when none is given; it is returned once, here.
  router.post('/', need('users.manage'), (req, res) => {
    const { data, errors } = accounts.parse(req.body || {});
    if (errors.length) return fail(res, errors);
    const r = accounts.create(data, { by: req.user.username, generate: req.body?.generate === true });
    if (r.errors) return fail(res, r.errors);
    auditLog.admin('service_account.create', { actor: who(req), target: target(r.account), detail: { grants: r.account.grants, enabled: r.account.enabled, password: r.account.has_password, keys: r.account.public_keys.length } });
    return res.status(201).json({ accounts: accounts.list(), account: r.account, ...(r.password ? { generated_password: r.password } : {}) });
  });

  router.put('/:id', need('users.manage'), (req, res) => {
    const existing = accounts.get(req.params.id);
    if (!existing) return fail(res, 'No such service account.', 404);
    const { data, errors } = accounts.parse(req.body || {}, existing.id);
    if (errors.length) return fail(res, errors);
    // A locked-down account stays off and keyless until its lockdown ends, so an edit cannot undo the lockdown.
    if (existing.locked_down && (data.enabled || data.public_keys !== '[]')) {
      return fail(res, 'This account is in lockdown. End the lockdown before turning it on or giving it keys.', 409);
    }
    const account = accounts.update(existing.id, data);
    auditLog.admin('service_account.update', { actor: who(req), target: target(account), detail: { grants: account.grants, enabled: account.enabled, enabled_changed: existing.enabled !== account.enabled, password_changed: Boolean(data.password), keys: account.public_keys.length } });
    return res.json({ accounts: accounts.list(), account });
  });

  router.post('/:id/password', need('users.manage'), (req, res) => {
    const existing = accounts.get(req.params.id);
    if (!existing) return fail(res, 'No such service account.', 404);
    const r = accounts.resetPassword(existing.id);
    auditLog.admin('service_account.password_reset', { actor: who(req), target: target(existing) });
    return res.json({ accounts: accounts.list(), account: r.account, generated_password: r.password });
  });

  // Locks the account down: off, password replaced, keys suspended, and its open SFTP connections closed at once.
  router.post('/:id/lockdown', need('users.manage'), (req, res) => {
    const existing = accounts.get(req.params.id);
    if (!existing) return fail(res, 'No such service account.', 404);
    if (existing.locked_down) return fail(res, 'This account is already in lockdown.', 409);
    const r = accounts.lockDown(existing.id, { by: req.user.username });
    if (!r) return fail(res, 'This account is already in lockdown.', 409);
    const closed = sftp.disconnect(existing.username);
    const account = accounts.get(existing.id);
    auditLog.admin('service_account.lockdown', { actor: who(req), target: target(existing), detail: { keys_suspended: r.keysSuspended, connections_closed: closed, enabled_before: existing.enabled } });
    return res.json({ accounts: accounts.list(), account });
  });

  // Ends the lockdown. The account is turned on again only if it was on before; keys come back only with restore_keys.
  router.delete('/:id/lockdown', need('users.manage'), (req, res) => {
    const existing = accounts.get(req.params.id);
    if (!existing) return fail(res, 'No such service account.', 404);
    if (!existing.locked_down) return fail(res, 'This account is not in lockdown.', 409);
    const r = accounts.endLockdown(existing.id, { restoreKeys: req.body?.restore_keys === true });
    const account = accounts.get(existing.id);
    auditLog.admin('service_account.lockdown_end', { actor: who(req), target: target(existing), detail: { enabled: account.enabled, keys_restored: r.keysRestored } });
    return res.json({ accounts: accounts.list(), account });
  });

  router.delete('/:id', need('users.manage'), (req, res) => {
    const existing = accounts.get(req.params.id);
    if (!existing) return fail(res, 'No such service account.', 404);
    accounts.remove(existing.id);
    auditLog.admin('service_account.delete', { actor: who(req), target: target(existing) });
    return res.json({ accounts: accounts.list() });
  });

  return router;
};
