const express = require('express');
const auditLog = require('../audit');
const feed = require('../grouper-feed');
const bundle = require('../grouper-loader-bundle');
const { zip } = require('../zip');

// Console routes for the loader feed, mounted under /api/admin/grouper/loader (after requireAdmin).
// The feed discloses every group and member identifier, so these need both Grouper and group access.

module.exports = function grouperLoaderRoutes(need) {
  const router = express.Router();
  router.use(need('grouper.manage'), need('groups.view'));

  const summary = () => {
    const cfg = feed.config();
    const f = feed.buildFeed(cfg);
    return { ...feed.view(cfg), counts: { groups: f.groups.length, memberships: f.memberships.length, skipped: f.skipped } };
  };

  router.get('/', (req, res) => res.json(summary()));

  router.put('/', (req, res) => {
    const { options, errors } = feed.parseOptions(req.body || {});
    if (errors.length) return res.status(400).json({ errors });
    feed.saveConfig({ ...feed.config(), ...options });
    auditLog.admin('settings.grouper_loader', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'grouper loader feed' } });
    return res.json(summary());
  });

  router.post('/token', (req, res) => {
    const { token, hash } = feed.newToken();
    feed.saveConfig({ ...feed.config(), tokenHash: hash, tokenCreatedAt: new Date().toISOString() });
    auditLog.admin('token.grouper_loader.create', { actor: auditLog.who(req.user), target: { type: 'token', name: 'grouper loader feed' } });
    res.status(201).json({ ...summary(), token });
  });

  router.delete('/token', (req, res) => {
    feed.saveConfig({ ...feed.config(), tokenHash: '', tokenCreatedAt: '' });
    auditLog.admin('token.grouper_loader.delete', { actor: auditLog.who(req.user), target: { type: 'token', name: 'grouper loader feed' } });
    res.json(summary());
  });

  router.get('/bundle', (req, res) => {
    const cfg = feed.config();
    const f = feed.buildFeed(cfg);
    const base = feed.view(cfg).urls.base;
    const stems = [...new Set(f.groups.map((g) => g.group_name.split(':')[0]))].sort();
    const files = {
      'README.txt': bundle.readme(cfg, base, { groups: f.groups.length, memberships: f.memberships.length }),
      'staging.sql': bundle.staging(cfg),
      'sync.sh': bundle.syncScript(cfg, base),
      'loader-settings.txt': bundle.loaderSettings(cfg, stems),
    };
    res.set({ 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="simpleidp-grouper-loader.zip"', 'cache-control': 'no-store' });
    res.send(zip(files));
  });

  return router;
};
