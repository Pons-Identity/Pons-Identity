const express = require('express');
const folders = require('../group-folders');
const auditLog = require('../audit');

// Console routes for group folders, mounted under /api/admin/group-folders (after requireAdmin). Folders only
// organize groups, so editing them needs groups.manage and nothing about a group itself changes.

module.exports = function folderRoutes(need) {
  const router = express.Router();
  const ctx = (req) => ({ actor: auditLog.who(req.user), name: req.user.username });
  const handle = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      if (!(e instanceof folders.FolderError)) throw e;
      res.status(e.status).json({ error: e.message, errors: [e.message] });
    }
  };

  router.get('/tree', need('groups.view'), (req, res) => res.json(folders.tree()));

  router.post('/', need('groups.manage'), handle((req, res) => {
    const f = folders.createFolder(ctx(req), req.body || {});
    res.status(201).json({ ...f, path: folders.pathOf(f.id) });
  }));

  router.put('/:id', need('groups.manage'), handle((req, res) => {
    const f = folders.updateFolder(ctx(req), Number(req.params.id), req.body || {});
    res.json({ ...f, path: folders.pathOf(f.id) });
  }));

  // Its groups and subfolders move up one level.
  router.delete('/:id', need('groups.manage'), handle((req, res) => {
    folders.deleteFolder(ctx(req), Number(req.params.id));
    res.status(204).end();
  }));

  // Drag and drop: { type: 'group' | 'folder', id, parent_id (null = top level), before_id (optional sibling) }.
  router.post('/move', need('groups.manage'), handle((req, res) => {
    folders.place(ctx(req), req.body || {});
    res.json(folders.tree());
  }));

  return router;
};
