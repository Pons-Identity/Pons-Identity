const express = require('express');
const fonts = require('../fonts');
const assets = require('../assets');

// Public, because the sign-in page needs them too: the font stylesheet (every installed font, or one family), the font files it
// names, and the images an administrator uploaded. Brand fonts and images are not secret, and each file keeps its id for as long
// as it exists, so its address can be cached for a year.
const router = express.Router();
const IMMUTABLE = 'public, max-age=31536000, immutable';

router.get('/font.css', (req, res) => {
  const family = typeof req.query.family === 'string' ? req.query.family : '';
  res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.send(fonts.stylesheet(family));
});

router.get('/font-files/:id', (req, res) => {
  const file = fonts.file(Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Not found.' });
  // Set exactly: res.send would add a charset to the font's type, which a binary file does not have.
  res.setHeader('Content-Type', file.mime);
  res.set('Cache-Control', IMMUTABLE);
  res.end(file.data);
});

router.get('/assets/:id', (req, res) => {
  const file = assets.file(Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Not found.' });
  res.setHeader('Content-Type', file.mime);
  res.set('Cache-Control', IMMUTABLE);
  res.end(file.data);
});

module.exports = router;
