const express = require('express');
const db = require('../db');
const guests = require('../guests');
const roles = require('../roles');
const policies = require('../policies');
const userService = require('../user-service');
const auditLog = require('../audit');
const { toArr, str } = require('../admin-data');

// "My guests": the signed-in person invites guests, chooses which of their own roles each may use, and can switch a guest
// off or remove them. Mounted under /api/my/guests for any active account that is not itself a guest.
module.exports = function guestRoutes() {
  const router = express.Router();
  const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });
  const target = (g) => ({ type: 'user', id: g.id, name: g.username });

  router.use((req, res, next) => {
    if (req.user.host_id) return res.status(403).json({ error: 'Guests cannot host guests.' });
    next();
  });

  // Someone who is no longer in a chosen group can still see and remove the guests they have, but not add or change them.
  router.use((req, res, next) => {
    if (['GET', 'DELETE'].includes(req.method) || guests.canHost(req.user)) return next();
    return res.status(403).json({ error: 'You are not allowed to host guests.' });
  });

  const own = (req, res, next) => {
    req.guest = db.get('SELECT * FROM users WHERE id = ? AND host_id = ?', Number(req.params.id), req.user.id);
    return req.guest ? next() : res.status(404).json({ error: 'No such guest.' });
  };

  const roleIdsOf = (body) => [...new Set(toArr(body.role_ids).map(Number).filter(Number.isInteger))];

  router.get('/', (req, res) => {
    res.json({ can_host: guests.canHost(req.user), guests: guests.guestsOf(req.user.id).map(guests.view), assignable_roles: guests.assignableRoles(req.user.id), limit: guests.guestLimit(req.user), max_days: guests.settings().maxDays });
  });

  router.post('/', async (req, res, next) => {
    try {
      const username = str(req.body.username);
      const email = str(req.body.email);
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      const roleIds = roleIdsOf(req.body);
      const errors = [];
      if (!username) errors.push('Username is required.');
      else if (db.get('SELECT 1 FROM users WHERE username = ?', username)) errors.push('That username already exists.');
      if (!password) errors.push('A password is required.');
      const expiryErr = guests.expiryError(req.body.expires_at);
      if (expiryErr) errors.push(expiryErr);
      const limit = guests.guestLimit(req.user);
      if (guests.guestsOf(req.user.id).length >= limit) errors.push(`You can host at most ${limit} guest${limit === 1 ? '' : 's'}.`);
      const em = userService.readEmails({}, email);
      errors.push(...em.errors, ...guests.roleErrors(req.user.id, roleIds));
      const fields = { username, first_name: str(req.body.first_name), last_name: str(req.body.last_name), display_name: str(req.body.display_name), email: em.emails.length ? em.emails[0].email : '' };
      if (!fields.display_name) fields.display_name = `${fields.first_name} ${fields.last_name}`.trim();
      if (password && !errors.length) errors.push(...await policies.draftPasswordErrors({ roleIds, groupIds: [] }, password, fields));
      if (errors.length) return fail(res, errors);
      const id = guests.create(req.user, { fields, email: fields.email, password, roleIds, expiresAt: req.body.expires_at }, req.user.id);
      const g = db.get('SELECT * FROM users WHERE id = ?', id);
      auditLog.user('guest.create', { actor: auditLog.who(req.user), target: target(g), detail: { host: req.user.username, roles: roleIds, expires_at: g.expires_at } });
      res.status(201).json(guests.view(g));
    } catch (e) { next(e); }
  });

  router.put('/:id', own, async (req, res, next) => {
    try {
      const g = req.guest;
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      const rolesBefore = roles.roleIds(g.id);
      const roleIds = req.body.role_ids === undefined ? rolesBefore : roleIdsOf(req.body);
      // Roles the guest already holds stay even if the host no longer holds all of them; only newly added ones are checked.
      const errors = guests.roleErrors(req.user.id, roleIds.filter((id) => !rolesBefore.includes(id)));
      if (req.body.expires_at !== undefined) {
        const e = guests.expiryError(req.body.expires_at);
        if (e) errors.push(e);
      }
      if (password) errors.push(...await policies.passwordErrors(g.id, password));
      if (errors.length) return fail(res, errors);
      // Giving an expired guest more time turns them back on, unless this request says otherwise.
      const extended = req.body.expires_at !== undefined && guests.expired(g);
      const active = req.body.active === undefined ? (extended ? 1 : g.active) : (req.body.active ? 1 : 0);
      db.tx(() => {
        db.run('UPDATE users SET display_name = ?, first_name = ?, last_name = ?, active = ? WHERE id = ?',
          req.body.display_name === undefined ? g.display_name : str(req.body.display_name),
          req.body.first_name === undefined ? g.first_name : str(req.body.first_name),
          req.body.last_name === undefined ? g.last_name : str(req.body.last_name), active, g.id);
        guests.setRoles(g.id, roleIds);
        if (req.body.expires_at !== undefined) db.run('UPDATE users SET expires_at = ? WHERE id = ?', new Date(req.body.expires_at).toISOString(), g.id);
        if (password) userService.setPassword(g.id, password, { by: req.user.id, via: 'admin' });
      });
      if (!active) userService.revokeSessions(g.id);
      auditLog.user('guest.update', { actor: auditLog.who(req.user), target: target(g), detail: {
        active: Boolean(active), expires_at: req.body.expires_at === undefined ? undefined : new Date(req.body.expires_at).toISOString(), added_roles: roleIds.filter((r) => !rolesBefore.includes(r)), removed_roles: rolesBefore.filter((r) => !roleIds.includes(r)), password_reset: Boolean(password) } });
      res.json(guests.view(db.get('SELECT * FROM users WHERE id = ?', g.id)));
    } catch (e) { next(e); }
  });

  router.delete('/:id', own, (req, res) => {
    userService.revokeSessions(req.guest.id);
    db.run('DELETE FROM users WHERE id = ?', req.guest.id);
    auditLog.user('guest.delete', { actor: auditLog.who(req.user), target: target(req.guest), detail: { host: req.user.username } });
    res.status(204).end();
  });

  return router;
};
