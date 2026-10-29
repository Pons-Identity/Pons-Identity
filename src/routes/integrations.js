const express = require('express');
const db = require('../db');
const integrations = require('../integrations');
const variables = require('../integrations/variables');
const functions = require('../integrations/functions');
const inputNames = require('../integrations/input-names');
const inputValues = require('../integrations/inputs');
const host = require('../integrations/host');
const docs = require('../integrations/docs');
const events = require('../integrations/events');
const schedules = require('../integrations/schedule');
const engine = require('../integrations/engine');
const logging = require('../integrations/logging');
const logStore = require('../files/logs');
const gitRepo = require('../integrations/git');
const auditLog = require('../audit');
const search = require('../search');
const { baseUrl } = require('../config');

// Console routes for integrations, mounted under /api/admin/integrations, and the public webhook that starts one.

const who = (req) => auditLog.who(req.user);
const target = (i) => ({ type: 'integration', id: i.id, name: i.name });
const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });

module.exports = function integrationRoutes(need) {
  const router = express.Router();

  // Everything the page needs besides the integrations themselves: what scripts can use, for the editor's reference panel.
  router.get('/', need('integrations.view'), (req, res) => res.json({
    integrations: search.searchIntegrations({ q: req.query.q }).results,
    scopes: host.SCOPES,
    reference: docs.reference(),
    events: events.catalog().map(({ name, label, fields }) => ({ name, label, fields })),
    scheduleLimits: { minMinutes: schedules.MIN_MINUTES, maxMinutes: schedules.MAX_MINUTES, maxPerIntegration: schedules.MAX_PER_INTEGRATION, customUnits: Object.fromEntries(Object.entries(schedules.CUSTOM_UNITS).map(([u, v]) => [u, v.max])), days: schedules.DAYS },
    webhookBase: baseUrl,
    starter: integrations.STARTER,
    starter_inputs: integrations.STARTER_INPUTS,
  }));

  /* -------------------------------- Variables -------------------------------- */

  router.get('/variables', need('integrations.view'), (req, res) => res.json({ variables: variables.list() }));

  router.put('/variables/:name', need('integrations.manage'), (req, res) => {
    const r = variables.save(req.params.name, req.body || {});
    if (r.errors) return fail(res, r.errors);
    // The name and whether it is secret, never the value.
    auditLog.admin(r.created ? 'integration.variable.create' : 'integration.variable.update', { actor: who(req), target: { type: 'integration_variable', name: r.variable.name }, detail: { secret: r.variable.secret } });
    res.json({ variables: variables.list() });
  });

  router.delete('/variables/:name', need('integrations.manage'), (req, res) => {
    if (variables.remove(req.params.name)) auditLog.admin('integration.variable.delete', { actor: who(req), target: { type: 'integration_variable', name: req.params.name } });
    res.json({ variables: variables.list() });
  });

  /* -------------------------------- Functions -------------------------------- */

  router.get('/functions', need('integrations.view'), (req, res) => res.json({ functions: functions.list(), inputs: inputNames.catalog }));

  router.put('/functions/:name', need('integrations.manage'), (req, res) => {
    const r = functions.save(req.params.name, req.body || {}, req.user.username);
    if (r.errors) return fail(res, r.errors);
    auditLog.admin(r.created ? 'integration.function.create' : 'integration.function.update', { actor: who(req), target: { type: 'integration_function', name: r.function.name } });
    res.json({ functions: functions.list() });
  });

  router.delete('/functions/:name', need('integrations.manage'), (req, res) => {
    if (functions.remove(req.params.name)) auditLog.admin('integration.function.delete', { actor: who(req), target: { type: 'integration_function', name: req.params.name } });
    res.json({ functions: functions.list() });
  });

  /* --------------------------------- Logging --------------------------------- */

  const loggingView = () => ({ settings: logging.get(), levels: logging.LEVELS.map((id) => ({ id, label: logging.LEVEL_LABELS[id] })), colors: logging.COLORS });

  router.get('/logging', need('integrations.view'), (req, res) => res.json(loggingView()));

  router.put('/logging', need('integrations.manage'), (req, res) => {
    const { data, errors } = logging.parse(req.body || {});
    if (errors.length) return fail(res, errors);
    logging.save(data);
    auditLog.admin('integration.logging.update', { actor: who(req), target: { type: 'integration_logging', name: 'logging' }, detail: { saveLevel: data.saveLevel, saveOutput: data.saveOutput, retentionDays: data.retentionDays } });
    res.json(loggingView());
  });

  // The saved log lines, read from the files module (/logs). Filters: integration, run, level (this and above), stream (log |
  // output), q, from, to, limit.
  router.get('/logs', need('integrations.view'), (req, res) => res.json(logStore.query(req.query)));

  // Deletes saved log files: one integration's, or all of them. The runs' own output and log are not affected.
  router.delete('/logs', need('integrations.manage'), (req, res) => {
    const removed = logStore.clear(req.query.integration);
    auditLog.admin('integration.logging.clear', { actor: who(req), target: { type: 'integration_logging', name: 'logging' }, detail: { integration: req.query.integration ? Number(req.query.integration) : 'all', removed } });
    res.json({ removed });
  });

  /* ----------------------------------- Git ----------------------------------- */

  // Version control for the integrations page (integrations/git.js). Declared before the /:id routes so "git" is not read as an id.
  const gitFail = (res, e) => (e instanceof gitRepo.GitError ? fail(res, e.message, e.status) : fail(res, 'Git failed unexpectedly.', 500));
  const remoteForAudit = (u) => { try { const p = new URL(u); return `${p.origin}${p.pathname}`; } catch { return ''; } };

  router.get('/git', need('integrations.view'), async (req, res) => {
    try { res.json(await gitRepo.status()); } catch (e) { gitFail(res, e); }
  });

  router.post('/git/commit', need('integrations.manage'), async (req, res) => {
    const b = req.body || {};
    try {
      const r = await gitRepo.commit({ message: b.message, branch: b.branch, author: { name: req.user.display_name || req.user.username, email: req.user.email } });
      auditLog.admin('integration.git.commit', { actor: who(req), target: { type: 'integration_git', name: r.branch }, detail: { branch: r.branch, files: r.files, commit: r.last && r.last.short, initialized: r.created } });
      res.status(201).json({ ...r, status: await gitRepo.status() });
    } catch (e) { gitFail(res, e); }
  });

  // The access token is used for this request and is not stored, logged or audited.
  router.post('/git/push', need('integrations.manage'), async (req, res) => {
    const b = req.body || {};
    try {
      const r = await gitRepo.push({ remoteUrl: b.remoteUrl, branch: b.branch, token: b.token });
      auditLog.admin('integration.git.push', { actor: who(req), target: { type: 'integration_git', name: r.branch }, detail: { remote: remoteForAudit(r.remoteUrl), branch: r.branch, commit: r.last && r.last.short } });
      res.json({ ...r, status: await gitRepo.status() });
    } catch (e) {
      auditLog.admin('integration.git.push', { outcome: 'failure', actor: who(req), target: { type: 'integration_git', name: String(b.branch || '') }, detail: { remote: remoteForAudit(String(b.remoteUrl || '')), error: e.message ? String(e.message).slice(0, 200) : 'failed' } });
      gitFail(res, e);
    }
  });

  /* ------------------------------- Integrations ------------------------------ */

  const load =(req, res, next) => {
    const i = integrations.get(req.params.id);
    if (!i) return fail(res, 'No such integration.', 404);
    req.integration = i;
    next();
  };

  router.post('/', need('integrations.manage'), (req, res) => {
    const { data, errors } = integrations.parse(req.body || {});
    if (errors.length) return fail(res, errors);
    const r = integrations.create(data, req.user.username);
    if (r.errors) return fail(res, r.errors);
    auditLog.admin('integration.create', { actor: who(req), target: target(r.integration), detail: { scopes: r.integration.scopes, schedules: r.integration.schedules.map((s) => s.label), events: r.integration.events } });
    res.status(201).json(r.integration);
  });

  router.get('/:id', need('integrations.view'), load, (req, res) => res.json({ ...req.integration, runs: integrations.runs(req.integration.id) }));

  router.put('/:id', need('integrations.manage'), load, (req, res) => {
    const { data, errors } = integrations.parse(req.body || {}, req.integration.id);
    if (errors.length) return fail(res, errors);
    const saved = integrations.update(req.integration.id, data);
    // The script is not logged; that it changed, and the scopes it now holds, are.
    auditLog.admin('integration.update', { actor: who(req), target: target(saved),
      detail: { scopes: saved.scopes, enabled: saved.enabled, script_changed: saved.script !== req.integration.script, scopes_changed: saved.scopes.join() !== req.integration.scopes.join(),
        schedules: saved.schedules.map((s) => s.label), events: saved.events, run_groups: saved.run_groups.map((g) => g.name), api_enabled: saved.api_enabled, logging: saved.logging } });
    res.json({ ...saved, runs: integrations.runs(saved.id) });
  });

  router.delete('/:id', need('integrations.manage'), load, (req, res) => {
    if (!req.integration.deletable) return fail(res, 'This built-in integration cannot be deleted. Turn it off instead.', 409);
    integrations.remove(req.integration.id);
    auditLog.admin('integration.delete', { actor: who(req), target: target(req.integration) });
    res.json({ integrations: integrations.list() });
  });

  // Puts a built-in integration's original code back (name, description, script, scopes, inputs, time limit). Its settings stay.
  router.post('/:id/restore', need('integrations.manage'), load, (req, res) => {
    const r = integrations.restoreBuiltin(req.integration.id);
    if (r.errors) return fail(res, r.errors, r.errors[0].startsWith('Only') ? 409 : 400);
    auditLog.admin('integration.restore', { actor: who(req), target: target(r.integration), detail: { builtin: req.integration.builtin, script_changed: r.integration.script !== req.integration.script } });
    res.json({ ...r.integration, runs: integrations.runs(r.integration.id) });
  });

  // Checks a script without running it.
  router.post('/check', need('integrations.manage'), (req, res) => {
    const problem = engine.check(typeof req.body?.script === 'string' ? req.body.script : '');
    res.json({ ok: !problem, error: problem });
  });

  // Starts the saved script and answers at once with the run, still 'running', so the console can open its page. `values` is the
  // Run table: [{ name, type, value }], and any name may be given (a custom input). `input` is any JSON, for software that gives the
  // whole object. `save_level` ('off' or a level) is the lowest level whose log lines this run saves; left out, the integration's own
  // setting applies. A disabled integration can still be tried from here. The run's page fills in as it ends.
  router.post('/:id/run', need('integrations.manage'), load, (req, res, next) => {
    try {
      const row = db.get('SELECT * FROM integrations WHERE id = ?', req.integration.id);
      const saveLevel = req.body?.save_level;
      if (saveLevel !== undefined && saveLevel !== 'off' && !logging.LEVELS.includes(saveLevel)) return fail(res, `Save log lines at or above ${logging.LEVELS.join(', ')}, or off.`);
      let input = req.body?.input ?? null;
      if (req.body?.values !== undefined) {
        const values = inputValues.parseValues(req.body.values);
        if (values.errors.length) return fail(res, values.errors);
        input = inputValues.valuesToInput(values.rows);
      }
      const { runId, done } = integrations.startRun(row, { input, trigger: row.enabled ? 'manual' : 'test', actor: req.user.username, saveLevel });
      done.catch((e) => console.error(`integration ${row.name}: run ${runId} could not be recorded`, e));
      res.status(202).json({ run: integrations.runView(db.get('SELECT * FROM integration_runs WHERE id = ?', runId)) });
    } catch (e) { next(e); }
  });

  // Starts a run again with the input of the run given, for a run page that is reloaded. Answers with the new run, still 'running'.
  router.post('/:id/runs/:runId/rerun', need('integrations.manage'), load, (req, res, next) => {
    try {
      const again = integrations.rerunInput(req.integration.id, req.params.runId);
      if (again.error) return fail(res, again.error, again.status);
      const row = db.get('SELECT * FROM integrations WHERE id = ?', req.integration.id);
      const { runId, done } = integrations.startRun(row, { input: again.input, trigger: row.enabled ? 'manual' : 'test', actor: req.user.username });
      done.catch((e) => console.error(`integration ${row.name}: run ${runId} could not be recorded`, e));
      res.status(202).json({ run: integrations.runView(db.get('SELECT * FROM integration_runs WHERE id = ?', runId)) });
    } catch (e) { next(e); }
  });

  // One run, for its page: the integration's name and the run's node, times, output, log and result.
  router.get('/:id/runs/:runId', need('integrations.view'), load, (req, res) => {
    const run = integrations.getRun(req.integration.id, req.params.runId);
    if (!run) return fail(res, 'No such run.', 404);
    res.json({ integration: { id: req.integration.id, name: req.integration.name }, run });
  });

  // A run's output and log as they are printed, pushed over one connection (Server-Sent Events): a 'snapshot' of the lines so far,
  // then a 'line' for each new one, then an 'end' with the finished run.
  router.get('/:id/runs/:runId/stream', need('integrations.view'), load, (req, res) => {
    const run = integrations.getRun(req.integration.id, req.params.runId);
    if (!run) return fail(res, 'No such run.', 404);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    const finish = () => {
      clearInterval(heartbeat);
      send('end', integrations.getRun(req.integration.id, run.id));
      res.end();
    };
    const stop = integrations.follow(run.id, {
      snapshot: (lines) => send('snapshot', lines),
      line: (stream, line) => send('line', { stream, line }),
      end: finish,
    });
    if (!stop) return finish();
    req.on('close', () => { clearInterval(heartbeat); stop(); });
  });

  router.post('/:id/webhook', need('integrations.manage'), load, (req, res) => {
    const token = integrations.newWebhookToken(req.integration.id);
    auditLog.admin('integration.webhook.create', { actor: who(req), target: target(req.integration) });
    res.json({ ...integrations.get(req.integration.id), token });
  });

  router.delete('/:id/webhook', need('integrations.manage'), load, (req, res) => {
    integrations.clearWebhookToken(req.integration.id);
    auditLog.admin('integration.webhook.delete', { actor: who(req), target: target(req.integration) });
    res.json(integrations.get(req.integration.id));
  });

  return router;
};

// POST /hooks/integrations/:id with `Authorization: Bearer iwh_…` and a JSON body: runs the integration with the body as
// `input` and answers { status, result, logs, error }. No cookies or CSRF; the token is the credential. A wrong id and a
// wrong token get the same answer so ids cannot be probed.
const hook = express.Router();
const failed = new Map();
const MAX_FAILURES = 20;
const WINDOW_MS = 60 * 1000;

hook.post('/:id', express.json({ limit: '1mb' }), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const now = Date.now();
    const recent = (failed.get(req.ip) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_FAILURES) return res.status(429).json({ error: 'Too many failed attempts. Try again shortly.' });
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const row = /^\d+$/.test(req.params.id) ? db.get('SELECT * FROM integrations WHERE id = ?', Number(req.params.id)) : null;
    if (!row || !m || !integrations.webhookMatches(row, m[1])) {
      recent.push(now);
      failed.set(req.ip, recent);
      if (failed.size > 5000) for (const [k, v] of failed) if (!v.some((t) => now - t < WINDOW_MS)) failed.delete(k);
      auditLog.user('token.auth_failure', { outcome: 'failure', actor: { type: 'anonymous', name: 'integration-webhook' }, detail: { api: 'integration-webhook', tokenPresented: Boolean(m) } });
      res.set('WWW-Authenticate', 'Bearer realm="Pons Identity integration"');
      return res.status(401).json({ error: 'A valid bearer token is required.' });
    }
    if (!row.enabled) return res.status(409).json({ error: 'This integration is turned off.' });
    const { outcome } = await integrations.execute(row, { input: req.body === undefined ? null : req.body, trigger: 'webhook', actor: 'webhook' });
    res.status(outcome.status === 'ok' ? 200 : outcome.status === 'timeout' ? 504 : 422).json({
      status: outcome.status, result: outcome.result ? JSON.parse(outcome.result) : null, logs: outcome.logs, output: outcome.output, error: outcome.error,
    });
  } catch (e) { next(e); }
});

hook.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports.hook = hook;
