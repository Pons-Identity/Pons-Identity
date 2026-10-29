const express = require('express');
const groupApi = require('../group-api');
const auditLog = require('../audit');
const { baseUrl } = require('../config');

// Console routes for the group API's tokens and the SQL views, mounted under /api/admin/group-api.

module.exports = function groupApiRoutes(need) {
  const router = express.Router();
  router.use(need('groupapi.manage'));

  const view = () => ({
    apiUrl: `${baseUrl}${groupApi.BASE}`,
    tokens: groupApi.listTokens(),
    sqlViews: require('../group-sql').VIEWS,
  });

  router.get('/', (req, res) => res.json(view()));

  // The token is returned only here; only its hash is stored.
  router.post('/tokens', (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const scope = req.body.scope;
    const errors = [];
    if (!name || name.length > 100) errors.push('Name the token (up to 100 characters) so you can tell it apart.');
    if (!['read', 'write'].includes(scope)) errors.push('Scope must be read or write.');
    if (errors.length) return res.status(400).json({ errors });
    const { id, token } = groupApi.createToken({ name, scope, createdBy: req.user.username });
    auditLog.admin('token.group_api.create', { actor: auditLog.who(req.user), target: { type: 'token', id, name: `group api: ${name}` }, detail: { scope } });
    return res.status(201).json({ ...view(), token });
  });

  router.delete('/tokens/:id', (req, res) => {
    if (groupApi.revokeToken(req.params.id)) {
      auditLog.admin('token.group_api.delete', { actor: auditLog.who(req.user), target: { type: 'token', id: req.params.id, name: 'group api' } });
    }
    res.json(view());
  });

  return router;
};
