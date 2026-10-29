const express = require('express');
const db = require('../db');
const directories = require('../directories');
const ldap = require('../ldap');
const auditLog = require('../audit');
const provisioning = require('../provisioning');
const { BASE } = require('../directory-api');
const { baseUrl } = require('../config');

// Console routes for external directories, mounted under /api/admin/directories (after requireAdmin).

module.exports = function directoryRoutes(need) {
  const router = express.Router();
  router.use(need('directories.manage'));

  const fail = (res, errors) => res.status(400).json({ errors: [].concat(errors) });
  const load = (req, res, next) => {
    req.directory = directories.get(req.params.id);
    return req.directory ? next() : res.status(404).json({ error: 'No such directory.' });
  };
  const actor = (req) => auditLog.who(req.user);
  const target = (d) => ({ type: 'directory', id: d.id, name: d.name });
  const viewOf = (dir) => ({ ...directories.view(dir), apiUrl: `${baseUrl}${BASE}` });

  router.get('/', (req, res) => res.json({
    directories: directories.list().map(viewOf),
    defaults: Object.fromEntries(directories.TYPES.map((t) => [t, directories.defaultConfig(t)])),
    apiUrl: `${baseUrl}${BASE}`,
  }));

  router.post('/', (req, res) => {
    const { data, errors } = directories.parse(req.body);
    if (errors.length) return fail(res, errors);
    const id = Number(db.run('INSERT INTO directories (name, type, enabled, config) VALUES (?, ?, ?, ?)',
      data.name, data.type, 0, JSON.stringify(data.config)).lastInsertRowid);
    // A new directory stays off until it has been tested and a token exists, whatever the form said.
    auditLog.admin('directory.create', { actor: actor(req), target: target({ id, name: data.name }), detail: { type: data.type } });
    res.status(201).json(viewOf(directories.get(id)));
  });

  router.get('/:id', load, (req, res) => res.json(viewOf(req.directory)));

  router.put('/:id', load, (req, res) => {
    const { data, errors } = directories.parse(req.body, req.directory);
    if (errors.length) return fail(res, errors);
    db.run('UPDATE directories SET name = ?, type = ?, enabled = ?, config = ? WHERE id = ?',
      data.name, data.type, data.enabled ? 1 : 0, JSON.stringify(data.config), req.directory.id);
    auditLog.admin('directory.update', { actor: actor(req), target: target(req.directory), detail: {
      enabled: Boolean(data.enabled), renamed_from: req.directory.name !== data.name ? req.directory.name : undefined,
      // Which settings changed; the values (the bind password among them) are never logged.
      changed: Object.keys(data.config).filter((k) => JSON.stringify(data.config[k]) !== JSON.stringify((req.directory.config || {})[k])) } });
    res.json(viewOf(directories.get(req.directory.id)));
  });

  // Users the directory owns are kept (they just stop being federated); its groups go with it.
  router.delete('/:id', load, (req, res) => {
    db.tx(() => {
      db.run('DELETE FROM groups WHERE directory_id = ?', req.directory.id);
      db.run("UPDATE users SET directory_id = NULL, external_id = '' WHERE directory_id = ?", req.directory.id);
      db.run('DELETE FROM directories WHERE id = ?', req.directory.id);
    });
    auditLog.admin('directory.delete', { actor: actor(req), target: target(req.directory) });
    res.status(204).end();
  });

  // Creating a token replaces the previous one; the plaintext is returned only here.
  router.post('/:id/token', load, (req, res) => {
    const { token, hash } = directories.newToken();
    db.run('UPDATE directories SET token_hash = ?, token_created_at = ? WHERE id = ?', hash, new Date().toISOString(), req.directory.id);
    auditLog.admin('token.directory.create', { actor: actor(req), target: target(req.directory) });
    res.json({ ...viewOf(directories.get(req.directory.id)), token });
  });

  router.delete('/:id/token', load, (req, res) => {
    db.run("UPDATE directories SET token_hash = '', token_created_at = '' WHERE id = ?", req.directory.id);
    auditLog.admin('token.directory.delete', { actor: actor(req), target: target(req.directory) });
    res.json(viewOf(directories.get(req.directory.id)));
  });

  // Test the saved LDAP settings: bind, read the base, and optionally look a user up (never signs anyone in).
  router.post('/:id/test', load, async (req, res) => {
    const dir = req.directory;
    if (!directories.usesLdap(dir)) return fail(res, 'This directory has no LDAP server configured.');
    try {
      await ldap.testConnection(dir.config);
      auditLog.admin('directory.test', { actor: actor(req), target: target(dir) });
      const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
      if (!username) return res.json({ ok: true, message: 'Connected and read the search base.' });
      const found = await ldap.lookup(dir.config, username);
      if (!found) return res.json({ ok: false, message: `Connected, but the search found no single user for "${username}".` });
      res.json({ ok: true, message: `Found ${found.dn}.`, attributes: found.attributes, groups: found.groups });
    } catch (e) {
      if (!(e instanceof ldap.DirectoryError)) throw e;
      res.json({ ok: false, message: e.message });
    }
  });

  /* ----------------------------- Provisioning feed ---------------------------- */

  const feedView = (dir) => ({ ...provisioning.view(dir.id), reference: provisioning.reference(), pushUrl: `${baseUrl}${BASE}/feed` });
  router.get('/:id/feed', load, (req, res) => res.json(feedView(req.directory)));

  router.put('/:id/feed', load, (req, res) => {
    const before = provisioning.config(req.directory.id);
    const { data, errors } = provisioning.parseConfig(req.body, before);
    if (errors.length) return fail(res, errors);
    provisioning.saveConfig(req.directory.id, data);
    // Which settings changed, never the values: the pull credential must not reach the log.
    auditLog.admin('directory.feed_update', { actor: actor(req), target: target(req.directory), detail: {
      enabled: data.enabled, changed: Object.keys(data).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(before[k])) } });
    res.json(feedView(req.directory));
  });

  // Runs the saved feed settings on a file the administrator uploaded, or on the configured URL. dry_run only reports.
  router.post('/:id/feed/run', load, async (req, res, next) => {
    const { source, content, filename, dry_run: dryRun, force, mode } = req.body || {};
    const opts = { via: source === 'pull' ? 'pull' : 'upload', dryRun: dryRun === true, force: force === true, mode, actor: req.user.username };
    try {
      if (source === 'pull') return res.json(await provisioning.pull(req.directory, opts));
      if (typeof content !== 'string' || !content.trim()) return fail(res, 'Choose a file to upload.');
      const format = /\.json$/i.test(filename || '') ? 'json' : /\.csv$/i.test(filename || '') ? 'csv' : undefined;
      res.json(await provisioning.run(req.directory, content, { ...opts, format }));
    } catch (e) {
      if (!(e instanceof provisioning.FeedError)) return next(e);
      res.status(e.status).json({ error: e.message, errors: e.errors || [e.message] });
    }
  });

  router.get('/:id/feed/runs/:runId', load, (req, res) => {
    const r = provisioning.runDetail(req.directory.id, req.params.runId);
    return r ? res.json(r) : res.status(404).json({ error: 'No such run.' });
  });

  return router;
};
