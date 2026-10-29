const express = require('express');
const fonts = require('../fonts');

// Public, because the sign-in page needs the font too: the stylesheet for one installed family, and the files it names. Brand
// fonts are not secret, and a file keeps its id for as long as it exists, so its URL can be cached for a year.
const router = express.Router();

router.get('/font.css', (req, res) => {
  const family = typeof req.query.family === 'string' ? req.query.family : '';
  res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.send(family ? fonts.familyCss(family) : '');
});

router.get('/font-files/:id', (req, res) => {
  const file = fonts.file(Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Not found.' });
  // Set exactly: res.send would add a charset to the font's type, which a binary file does not have.
  res.setHeader('Content-Type', file.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(file.data);
});

module.exports = router;
