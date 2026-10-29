const express = require('express');
const appSettings = require('../app-settings');
const guard = require('../login-page-guard');

const router = express.Router();

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// The custom template and CSS, only for this site's own sign-in page. Never cached or shared, no CORS headers.
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const why = guard.fetchSuspicion(req);
  if (why) {
    // Same answer as for any other failure so a scraper learns nothing about what tripped it.
    guard.report('copy_suspected', req, { reason: why, source: req.ip });
    return res.status(403).json({ error: 'Not available.' });
  }
  const { loginTemplate, loginCss } = appSettings.branding();
  res.json({ template: loginTemplate, css: loginTemplate || loginCss ? `${loginCss}\n${guard.protectionCss()}` : '' });
});

// Loaded by the beacon rule in the CSS. From this site's own page the Referer is this site; from a copy it names the copy.
router.get('/beacon.gif', (req, res) => {
  const t = String(req.query.t || '');
  const ref = req.get('referer') || req.get('origin') || '';
  const host = guard.hostOf(ref);
  if (t === guard.watermark() && host && host !== guard.ownHost()) guard.report('clone_detected', req, { site: host, referrer: ref.slice(0, 200), source: host });
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }).send(PIXEL);
});

module.exports = router;
