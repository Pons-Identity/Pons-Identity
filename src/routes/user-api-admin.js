const express = require('express');
const userApi = require('../user-api');
const auditLog = require('../audit');
const { baseUrl } = require('../config');

// Console routes for the user API's tokens, mounted under /api/admin/user-api.

module.exports = function userApiRoutes(need) {
  const router = express.Router();
  router.use(need('userapi.manage'));

  const view = () => ({ apiUrl: `${baseUrl}${userApi.BASE}`, docsUrl: `${baseUrl}${userApi.BASE}/docs`, scopes: userApi.SCOPES, tokens: userApi.listTokens() });

  router.get('/', (req, res) => res.json(view()));

  // The token is returned only here; only its hash is stored.
  router.post('/tokens', (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const scopes = Array.isArray(req.body.scopes) ? [...new Set(req.body.scopes)] : [];
    const errors = [];
    if (!name || name.length > 100) errors.push('Name the token (up to 100 characters) so you can tell it apart.');
    if (!scopes.length || scopes.some((s) => !userApi.SCOPES[s])) errors.push('Choose at least one scope.');
    if (userApi.listTokens().some((t) => t.name === name)) errors.push('A token with that name already exists.');
    let expiresAt = '';
    if (req.body.expires_at) {
      const t = Date.parse(req.body.expires_at);
      if (!Number.isFinite(t) || t <= Date.now()) errors.push('The expiry must be a date in the future.');
      else expiresAt = new Date(t).toISOString();
    }
    if (errors.length) return res.status(400).json({ errors });
    const { id, token } = userApi.createToken({ name, scopes, expiresAt, createdBy: req.user.username });
    auditLog.admin('token.user_api.create', { actor: auditLog.who(req.user), target: { type: 'token', id, name: `user api: ${name}` }, detail: { scopes, expires_at: expiresAt } });
    return res.status(201).json({ ...view(), token });
  });

  router.delete('/tokens/:id', (req, res) => {
    if (userApi.revokeToken(req.params.id)) {
      auditLog.admin('token.user_api.delete', { actor: auditLog.who(req.user), target: { type: 'token', id: req.params.id, name: 'user api' } });
    }
    res.json(view());
  });

  return router;
};
