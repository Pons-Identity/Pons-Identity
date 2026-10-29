const express = require('express');
const db = require('../db');
const reports = require('../reports');
const builtin = require('../reports/builtin');
const functions = require('../reports/functions');
const builder = require('../reports/builder');
const engine = require('../integrations/engine');
const auditLog = require('../audit');

// Console routes for reports, mounted under /api/admin/reports. Results are sent back to the caller and not stored.

const who = (req) => auditLog.who(req.user);
const target = (r) => ({ type: 'report', id: r.id, name: r.name });
const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });

// Reads the optional JSON input, which a person types in.
const inputOf = (req) => (req.body && req.body.input !== undefined ? req.body.input : null);

module.exports = function reportRoutes(need) {
  const router = express.Router();

  router.get('/', need('reports.view'), (req, res) => res.json({
    builtin: builtin.BUILTIN.map((b) => ({ ...reports.builtinView(b, { script: false }), runnable: b.requires.every((p) => req.perms.has(p)) })),
    reports: reports.list(),
    reference: { functions: functions.REFERENCE, userFields: functions.USER_FIELDS.map(([name, type, description]) => ({ name, type, description })) },
    starter: reports.STARTER,
    builder: builder.catalog(),
    limits: { minSeconds: reports.TIMEOUT.min, maxSeconds: reports.TIMEOUT.max, defaultSeconds: reports.TIMEOUT.default, maxScript: engine.MAX_SCRIPT },
  }));

  // Runs a builder definition without saving it, so the editor can show what it will give.
  router.post('/builder/preview', need('reports.view'), async (req, res, next) => {
    try {
      const { data, errors } = builder.parse(req.body && req.body.definition);
      if (errors.length) return fail(res, errors);
      res.json(await reports.run({ name: 'Preview', kind: 'builder', definition: data }, { user: { id: req.user.id, username: req.user.username, perms: req.perms } }));
    } catch (e) { next(e); }
  });

  router.get('/builtin/:key', need('reports.view'), (req, res) => {
    const b = builtin.find(req.params.key);
    if (!b) return fail(res, 'No such report.', 404);
    res.json({ ...reports.builtinView(b), runnable: b.requires.every((p) => req.perms.has(p)) });
  });

  router.post('/builtin/:key/run', need('reports.view'), async (req, res, next) => {
    try {
      const b = builtin.find(req.params.key);
      if (!b) return fail(res, 'No such report.', 404);
      const missing = b.requires.filter((p) => !req.perms.has(p));
      if (missing.length) return fail(res, `This report needs the "${missing[0]}" permission.`, 403);
      const input = req.body && req.body.input !== undefined ? req.body.input : b.input;
      res.json(await reports.run({ name: b.name, script: b.script, timeoutSeconds: reports.TIMEOUT.default }, { input, user: { id: req.user.id, username: req.user.username, perms: req.perms }, key: b.key }));
    } catch (e) { next(e); }
  });

  // Checks a script without running it.
  router.post('/check', need('reports.manage'), (req, res) => {
    const problem = engine.check(typeof req.body?.script === 'string' ? req.body.script : '');
    res.json({ ok: !problem, error: problem });
  });

  router.post('/', need('reports.manage'), (req, res) => {
    const { data, errors } = reports.parse(req.body || {});
    if (errors.length) return fail(res, errors);
    const r = reports.create(data, req.user.username);
    if (r.errors) return fail(res, r.errors);
    auditLog.admin('report.create', { actor: who(req), target: target(r.report) });
    res.status(201).json(r.report);
  });

  const load = (req, res, next) => {
    const r = /^\d+$/.test(req.params.id) ? reports.get(req.params.id) : null;
    if (!r) return fail(res, 'No such report.', 404);
    req.report = r;
    next();
  };

  router.get('/:id', need('reports.view'), load, (req, res) => res.json(req.report));

  router.put('/:id', need('reports.manage'), load, (req, res) => {
    const { data, errors } = reports.parse(req.body || {}, req.report.id);
    if (errors.length) return fail(res, errors);
    const saved = reports.update(req.report.id, data);
    // The script text is not logged; that it changed is.
    auditLog.admin('report.update', { actor: who(req), target: target(saved), detail: { script_changed: saved.script !== req.report.script } });
    res.json(saved);
  });

  router.delete('/:id', need('reports.manage'), load, (req, res) => {
    reports.remove(req.report.id);
    auditLog.admin('report.delete', { actor: who(req), target: target(req.report) });
    res.json({ reports: reports.list() });
  });

  router.post('/:id/run', need('reports.view'), load, async (req, res, next) => {
    try {
      const row = db.get('SELECT * FROM reports WHERE id = ?', req.report.id);
      const definition = row.kind === 'builder' ? JSON.parse(row.definition || '{}') : null;
      res.json(await reports.run({ id: row.id, name: row.name, kind: row.kind, definition, script: row.script, timeoutSeconds: row.timeout_seconds }, { input: inputOf(req), user: { id: req.user.id, username: req.user.username, perms: req.perms } }));
    } catch (e) { next(e); }
  });

  return router;
};
