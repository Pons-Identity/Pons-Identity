const express = require('express');
const auditLog = require('../audit');
const { buildModel, buildBundle, parseOptions, SUBJECT_FIELDS } = require('../grouper-export');
const { zip } = require('../zip');
const push = require('../grouper-push');
const job = require('../grouper-push-job');
const { WsError } = require('../grouper-ws');

// Console routes for moving the built-in groups to Internet2 Grouper, mounted under /api/admin/grouper/export
// (after requireAdmin): a downloadable bundle, and a push over Grouper's web services. Both disclose everyone's
// identifiers (the push sends them to another system), so they need both Grouper and group access.

module.exports = function grouperExportRoutes(need) {
  const router = express.Router();
  router.use(need('grouper.manage'), need('groups.view'));

  const optionsOf = (req, res, next) => {
    const { errors } = parseOptions(req.query);
    return errors.length ? res.status(400).json({ errors }) : next();
  };

  router.get('/fields', (req, res) => res.json({ subjectFields: SUBJECT_FIELDS }));

  // What would be exported, without the files.
  router.get('/preview', optionsOf, (req, res) => {
    const m = buildModel(req.query);
    res.json({ options: m.options, counts: m.counts, warnings: m.warnings, unresolved: m.unresolved.slice(0, 100), groups: m.groups.slice(0, 200).map((g) => g.name) });
  });

  router.get('/download', optionsOf, (req, res) => {
    const { files } = buildBundle(req.query);
    res.set({
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="simpleidp-grouper-export.zip"',
      'cache-control': 'no-store',
    });
    res.send(zip(files));
  });

  /* Push over web services. The connection details are used for the request or run and never stored. */

  // Validates the form and returns { ws, model, exportOptions, pushOptions } or answers 400.
  function prepare(req, res) {
    const body = req.body || {};
    const exp = parseOptions(body.options || {});
    const pu = push.parseOptions(body.options || {});
    const errors = [...exp.errors, ...pu.errors];
    let ws;
    if (!errors.length) {
      try { ws = job.connect(body.connection); } catch (err) { errors.push(err.message); }
    }
    if (errors.length) { res.status(400).json({ errors }); return null; }
    return { ws, model: buildModel(exp.options), pushOptions: pu.options, target: ws.baseUrl };
  }

  const upstream = (res, err) => {
    if (!(err instanceof WsError)) throw err;
    return res.status(err.auth || err.status === 404 ? 400 : 502).json({ errors: [err.message] });
  };

  // Read-only: does Grouper answer, and does it know the people in the export?
  router.post('/push/preflight', async (req, res) => {
    const p = prepare(req, res);
    if (!p) return undefined;
    try {
      const check = await push.preflight(p.ws, p.model, p.pushOptions);
      return res.json({ counts: p.model.counts, notPushed: { composites: p.model.counts.composites }, ...check });
    } catch (err) {
      return upstream(res, err);
    }
  });

  router.post('/push', (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ errors: ['Confirm that you want to write to Grouper.'] });
    const p = prepare(req, res);
    if (!p) return undefined;
    try {
      return res.status(202).json(job.start({ ws: p.ws, model: p.model, options: p.pushOptions, actor: req.user.username, target: p.target }));
    } catch (err) {
      return res.status(err.status || 500).json({ errors: [err.message] });
    }
  });

  router.get('/push/status', (req, res) => res.json(job.status()));
  router.post('/push/cancel', (req, res) => {
    auditLog.admin('grouper.push.cancel', { actor: auditLog.who(req.user), target: { type: 'grouper' } });
    res.json(job.cancel());
  });

  return router;
};
