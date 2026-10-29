const crypto = require('crypto');
const db = require('../db');

/**
 * The opaque identifier issued to `userId` for one SP. Created on first use and then never changes, so the SP
 * sees the same value every time and different SPs cannot correlate the user through it.
 */
function persistentId(userId, spEntityId) {
  if (!userId || !spEntityId) return '';
  db.run('INSERT OR IGNORE INTO persistent_ids (user_id, sp_entity_id, value) VALUES (?,?,?)',
    userId, spEntityId, crypto.randomBytes(20).toString('hex'));
  return db.get('SELECT value FROM persistent_ids WHERE user_id = ? AND sp_entity_id = ?', userId, spEntityId).value;
}

module.exports = { persistentId };
