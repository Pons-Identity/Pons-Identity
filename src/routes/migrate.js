const express = require('express');
const migrate = require('../migrate');

// Upload, preview and (for the console) apply an import from another identity provider. Shared by the setup wizard and the
// console: `ctx(req)` says whose staged files and previews these are, and `canApply` is false in the wizard, which applies the
// preview itself when the person finishes, in one step with creating the administrator.
const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });

module.exports = function migrateRoutes({ ctx, canApply }) {
  const router = express.Router();

  router.get('/', (req, res) => res.json({ sources: migrate.SOURCES, files: migrate.staging(ctx(req).owner), maxFileMb: migrate.MAX_FILE / 1024 / 1024 }));

  // The file is the request body as it is (application/octet-stream); its name and the slot it goes in (`kind`) are in the query.
  router.post('/files', express.raw({ type: () => true, limit: `${migrate.MAX_FILE}b` }), (req, res) => {
    const r = migrate.stage(ctx(req).owner, req.query.name, req.body, String(req.query.kind || ''));
    if (r.error) return fail(res, r.error);
    res.status(201).json({ id: r.id, files: migrate.staging(ctx(req).owner) });
  });

  router.delete('/files/:id', (req, res) => {
    migrate.unstage(ctx(req).owner, req.params.id);
    res.json({ files: migrate.staging(ctx(req).owner) });
  });

  router.post('/preview', (req, res) => {
    const b = req.body || {};
    const r = migrate.preview(ctx(req).owner, { source: typeof b.source === 'string' ? b.source : '', options: b.options || {} });
    if (r.errors) return fail(res, r.errors);
    res.json(r);
  });

  if (canApply) {
    router.post('/apply', (req, res) => {
      const b = req.body || {};
      const r = migrate.apply(ctx(req).owner, String(b.planId || ''), b.options || {}, ctx(req).actor);
      if (r.errors) return fail(res, r.errors, 410);
      res.json(r);
    });
  }
  return router;
};
