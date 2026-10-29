const express = require('express');
const logout = require('../saml/logout-flow');

// Sign-out is a form POST that renders the server-side SLO page (views/logout.ejs).
// Everything else a user sees is the React app, served over /api.
const router = express.Router();

router.post('/logout', (req, res) => logout.idpInitiated(req, res));

module.exports = router;
