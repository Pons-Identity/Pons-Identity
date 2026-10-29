const express = require('express');
const cutover = require('../grouper-cutover');
const job = require('../grouper-push-job');
const { WsError } = require('../grouper-ws');
const { parseOptions } = require('../grouper-export');

// Console routes for handing groups over to Grouper, mounted under /api/admin/grouper/cutover (after requireAdmin).
// Converting changes groups, so it needs group management as well as Grouper access.

module.exports = function grouperCutoverRoutes(need) {
  const router = express.Router();
  router.use(need('grouper.manage'), need('groups.manage'));

  const exportOptions = (req, res) => {
    const { options, errors } = parseOptions((req.body && req.body.options) || {});
    if (errors.length) { res.status(400).json({ errors }); return null; }
    return options;
  };
  const fail = (res, err) => {
    if (err instanceof cutover.CutoverError) return res.status(err.status).json({ errors: err.errors });
    if (err instanceof WsError) return res.status(err.auth || err.status === 404 ? 400 : 502).json({ errors: [err.message] });
    if (err.errors) return res.status(400).json({ errors: err.errors });
    throw err;
  };

  router.post('/plan', (req, res) => {
    const options = exportOptions(req, res);
    if (options) res.json(cutover.buildPlan(options));
  });

  // Read-only against Grouper: compares each group's members with what Grouper holds.
  router.post('/verify', async (req, res) => {
    const options = exportOptions(req, res);
    if (!options) return undefined;
    let ws;
    try { ws = job.connect(req.body.connection); } catch (err) { return res.status(400).json({ errors: [err.message] }); }
    try {
      return res.json(await cutover.verify(ws, options, req.body.options, req.body.groupIds));
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/apply', (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ errors: ['Confirm that you want to hand these groups to Grouper.'] });
    const options = exportOptions(req, res);
    if (!options) return undefined;
    try {
      return res.json(cutover.apply({
        groupIds: req.body.groupIds, exportOptions: options, actor: req.user.username,
        force: req.body.force === true, pinRoleMembers: req.body.pinRoleMembers !== false,
      }));
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/history', (req, res) => res.json(cutover.history()));

  router.post('/history/:id/revert', (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ errors: ['Confirm that you want to revert this cutover.'] });
    try { return res.json(cutover.revert(req.params.id, req.user.username)); } catch (err) { return fail(res, err); }
  });

  return router;
};
