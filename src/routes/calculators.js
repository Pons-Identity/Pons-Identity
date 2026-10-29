const express = require('express');
const policyCalculator = require('../policy-calculator');
const groupCalculator = require('../group-calculator');

// Console routes for the Policy calculator and the Group calculator, mounted under /api/admin/calculators (after requireAdmin).
// Both only read. Naming a person also needs the permission to view people, and naming an application the one to view
// applications, so the calculators never show someone what they could not look up themselves.

module.exports = function calculatorRoutes(need) {
  const router = express.Router();
  const asId = (v) => (v === undefined || v === '' ? null : Number(v));
  const allow = (res, perms, wanted) => {
    if (wanted.every((p) => perms.has(p))) return true;
    res.status(403).json({ error: 'You do not have permission to do that.' });
    return false;
  };

  router.get('/policy', need('policies.view'), (req, res) => {
    const userId = asId(req.query.user_id);
    const kind = req.query.kind ? String(req.query.kind) : null;
    const appId = req.query.app_id ? String(req.query.app_id) : null;
    if (!allow(res, req.perms, [...(userId ? ['users.view'] : []), ...(appId ? ['sps.view'] : [])])) return;
    if (userId !== null && !Number.isInteger(userId)) return res.status(400).json({ error: 'Choose a person from the list.' });
    const out = policyCalculator.calculate({ userId, kind, appId });
    return out.error ? res.status(400).json({ error: out.error }) : res.json(out);
  });

  router.get('/group', need('groups.view'), (req, res) => {
    const userId = asId(req.query.user_id);
    const groupId = asId(req.query.group_id);
    if (!allow(res, req.perms, userId ? ['users.view'] : [])) return;
    if ((userId !== null && !Number.isInteger(userId)) || (groupId !== null && !Number.isInteger(groupId))) return res.status(400).json({ error: 'Choose from the list.' });
    const out = groupCalculator.calculate({ userId, groupId });
    return out.error ? res.status(400).json({ error: out.error }) : res.json(out);
  });

  return router;
};
