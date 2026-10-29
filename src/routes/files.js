const express = require('express');
const files = require('../files/store');
const sftpServer = require('../files/sftp-server');
const auditLog = require('../audit');

// Console routes for the files module, mounted under /api/admin/files: browsing, moving and changing files and folders, and the
// SFTP server's settings. Looking at names needs integrations.view; the contents (which may be personal data) and every change
// need integrations.manage.

const who = (req) => auditLog.who(req.user);
const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });

// Runs a store call and turns its FileError into an answer the form can show.
function guarded(res, next, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof files.FileError) return fail(res, e.message);
    return next(e);
  }
}

// The file's text, or null if it is not plain text: no NUL bytes, and valid UTF-8.
function plainText(buf) {
  if (buf.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

module.exports = function fileRoutes(need) {
  const router = express.Router();

  // A folder and what is in it.
  router.get('/list', need('integrations.view'), (req, res, next) => guarded(res, next, () => {
    const dir = files.normalize(req.query.path || '/');
    const stat = files.stat(dir);
    if (!stat) return fail(res, 'No such folder.', 404);
    if (stat.kind !== 'dir') return fail(res, 'That is a file, not a folder.');
    return res.json({ stat, entries: files.list(dir), viewBytes: files.LIMITS.viewBytes });
  }));

  // A plain-text file small enough to read on the page, as its text. Other files and larger ones are refused; download those.
  router.get('/view', need('integrations.manage'), (req, res, next) => guarded(res, next, () => {
    const full = files.normalize(req.query.path || '');
    const buf = files.read(full);
    if (!buf) return fail(res, 'No such file.', 404);
    if (buf.length > files.LIMITS.viewBytes) return fail(res, `Only files up to ${files.LIMITS.viewBytes / 1024} KB can be viewed. Download this one instead.`, 413);
    const text = plainText(buf);
    if (text === null) return fail(res, 'This file is not plain text. Download it instead.', 415);
    auditLog.admin('file.view', { actor: who(req), target: { type: 'file', name: full }, detail: { size: buf.length } });
    return res.json({ text });
  }));

  // The file itself, whatever its type.
  router.get('/download', need('integrations.manage'), (req, res, next) => guarded(res, next, () => {
    const full = files.normalize(req.query.path || '');
    const buf = files.read(full);
    if (!buf) return fail(res, 'No such file.', 404);
    auditLog.admin('file.download', { actor: who(req), target: { type: 'file', name: full }, detail: { size: buf.length } });
    res.set('X-Content-Type-Options', 'nosniff');
    return res.attachment(files.nameOf(full)).type('application/octet-stream').send(buf);
  }));

  // The body is the file itself. Replaces the file at `path` if it is there.
  router.put('/upload', need('integrations.manage'), express.raw({ type: () => true, limit: `${files.LIMITS.fileBytes}b` }), (req, res, next) => guarded(res, next, () => {
    const full = files.normalize(req.query.path || '');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const saved = files.write(full, body, { by: req.user.username });
    auditLog.admin('file.upload', { actor: who(req), target: { type: 'file', name: full }, detail: { size: saved.size } });
    return res.json({ saved, entries: files.list(files.parentOf(full) || '/') });
  }));

  router.post('/folder', need('integrations.manage'), (req, res, next) => guarded(res, next, () => {
    const full = files.normalize(req.body?.path || '');
    files.mkdir(full, { by: req.user.username });
    auditLog.admin('file.mkdir', { actor: who(req), target: { type: 'file', name: full } });
    return res.status(201).json({ path: full });
  }));

  router.post('/move', need('integrations.manage'), (req, res, next) => guarded(res, next, () => {
    const from = files.normalize(req.body?.from || '');
    const to = files.normalize(req.body?.to || '');
    const moved = files.rename(from, to, { by: req.user.username });
    auditLog.admin('file.rename', { actor: who(req), target: { type: 'file', name: from }, detail: { to } });
    return res.json({ moved });
  }));

  // A file, or a folder with `recursive`, removed.
  router.delete('/entry', need('integrations.manage'), (req, res, next) => guarded(res, next, () => {
    const full = files.normalize(req.query.path || '');
    const recursive = req.query.recursive === 'true';
    const removed = files.remove(full, { recursive });
    if (removed) auditLog.admin('file.delete', { actor: who(req), target: { type: 'file', name: full }, detail: { recursive } });
    return res.json({ removed });
  }));

  /* ------------------------------------ SFTP ------------------------------------ */

  router.get('/sftp', need('integrations.view'), (req, res) => res.json(sftpServer.status()));

  // Answers once the server is listening (or has failed to), so the form shows what is really running.
  router.put('/sftp', need('integrations.manage'), async (req, res, next) => {
    try {
      const { data, errors } = sftpServer.parse(req.body || {});
      if (errors.length) return fail(res, errors);
      const saved = await sftpServer.save(data);
      auditLog.admin('sftp.settings.update', { actor: who(req), target: { type: 'sftp_server', name: 'SFTP server' }, detail: { enabled: data.enabled, port: data.port, bindAddress: data.bindAddress } });
      return res.json(saved);
    } catch (e) { return next(e); }
  });

  return router;
};
