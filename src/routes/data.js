const express = require('express');
const auditLog = require('../audit');
const exporter = require('../export');
const migrate = require('../migrate');
const { zip } = require('../zip');
const migrateRoutes = require('./migrate');

// The console's Migration and Export tools, mounted under /api/admin.
const PART_PERMISSION = { config: null, users: 'users.view', groups: 'groups.view', integrations: 'integrations.view' };

module.exports = function dataRoutes(need) {
  const router = express.Router();

  router.use('/migrate', need('migration.manage'), migrateRoutes({ ctx: (req) => ({ owner: `user:${req.user.id}`, actor: req.user }), canApply: true }));

  // What this person may export: the parts whose view permission they hold (configuration needs only export.manage).
  const allowed = (req) => exporter.PARTS.filter((p) => !PART_PERMISSION[p] || req.perms.has(PART_PERMISSION[p]));

  router.get('/export', need('export.manage'), (req, res) => res.json({ parts: exporter.PARTS.map((id) => ({ id, allowed: allowed(req).includes(id) })), formats: ['json', 'zip'] }));

  router.get('/export/download', need('export.manage'), (req, res) => {
    const asked = String(req.query.include || '').split(',').map((s) => s.trim()).filter(Boolean);
    const parts = exporter.PARTS.filter((p) => asked.includes(p));
    if (!parts.length) return res.status(400).json({ errors: ['Choose at least one thing to export.'] });
    const refused = parts.filter((p) => !allowed(req).includes(p));
    if (refused.length) return res.status(403).json({ errors: [`You do not have access to export: ${refused.join(', ')}.`] });
    const doc = exporter.build(parts, req.user.username);
    const zipped = req.query.format === 'zip';
    auditLog.admin('export.download', { actor: auditLog.who(req.user), detail: { parts, format: zipped ? 'zip' : 'json', users: doc.users ? doc.users.length : undefined } });
    const stamp = doc.exported_at.slice(0, 10);
    res.set('Cache-Control', 'no-store');
    if (zipped) {
      res.type('application/zip').set('Content-Disposition', `attachment; filename="pons-identity-export-${stamp}.zip"`).send(zip(exporter.files(doc)));
    } else {
      res.type('application/json').set('Content-Disposition', `attachment; filename="pons-identity-export-${stamp}.json"`).send(`${JSON.stringify(doc, null, 2)}\n`);
    }
  });

  return router;
};
