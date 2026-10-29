const express = require('express');
const db = require('../db');
const sps = require('../sps');
const roles = require('../roles');
const { buildMetadata } = require('../saml/metadata');

// File downloads for a service provider. Admin screens are the React app, served over /api.
const router = express.Router();

function requireSpView(req, res, next) {
  if (!req.session.userId) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  const u = db.get('SELECT * FROM users WHERE id = ? AND active = 1', req.session.userId);
  if (!u || !roles.permissionsOf(u.id).has('sps.view')) return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have permission to view service providers.' });
  next();
}

function loadAdminSp(req, res, next) {
  const sp = sps.getSp(req.params.id);
  if (!sp) return res.status(404).render('error', { title: 'Not found', message: 'No such service provider.' });
  req.sp = sp;
  next();
}

router.get('/sps/:id/cert.pem', requireSpView, loadAdminSp, (req, res) => {
  res.attachment(`idp-${req.sp.id}.crt`).type('application/x-pem-file').send(req.sp.cert_pem);
});

router.get('/sps/:id/metadata.xml', requireSpView, loadAdminSp, (req, res) => {
  res.attachment(`idp-metadata-${req.sp.id}.xml`).type('application/samlmetadata+xml').send(buildMetadata(req.sp));
});

module.exports = router;
