process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const messaging = require('../src/messaging');
const reminders = require('../src/group-attestation-reminders');
const att = require('../src/group-attestation');
const { seedAdmin } = require('../src/server');

seedAdmin();
const mkUser = (n, email) => Number(db.run('INSERT INTO users (guid, username, password_hash, active, email) VALUES (?,?,?,1,?)',
  newGuid(), n, hashPassword(`${n}-password`), email).lastInsertRowid);
const mona = mkUser('mona', 'mona@example.com');
const nell = mkUser('nell', 'nell@example.com');
const day = 24 * 3600;

// Email counts as configured for these tests; the messages go to `sent` instead of a mail server.
messaging.configured = () => true;
messaging.messaging = () => ({});
const sent = [];
const send = async (channel, to, msg, opts) => { sent.push({ to, subject: msg.subject, text: msg.text, rateKey: opts.rateKey }); };

const mkGroup = (name, managers, nextDue) => {
  const g = Number(db.run('INSERT INTO groups (name, description) VALUES (?, ?)', name, '').lastInsertRowid);
  for (const u of managers) db.run('INSERT INTO group_managers (group_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)', g, u, 'admin', 0);
  db.run('INSERT INTO group_attestation_policy (group_id, frequency, next_due, set_by, set_at) VALUES (?, ?, ?, ?, ?)', g, 'monthly', nextDue, 'admin', 0);
  return g;
};

test('an overdue group reminds its managers once a week until it is attested', async () => {
  const now = 2_000_000;
  const g = mkGroup('quarterly-review', [mona, nell], now - 3 * day);

  assert.equal(await reminders.sendReminders({ now, send }), 1);
  assert.deepEqual(sent.map((s) => s.to).sort(), ['mona@example.com', 'nell@example.com']);
  assert.match(sent[0].subject, /group attestation required/);
  assert.match(sent[0].text, /^- quarterly-review \(due \d{4}-\d{2}-\d{2}\): /m);
  assert.match(sent[0].text, new RegExp(`/groups/${g}$`, 'm'));

  // Not again until a week has passed.
  sent.length = 0;
  assert.equal(await reminders.sendReminders({ now: now + day, send }), 0);
  assert.equal(sent.length, 0);
  assert.equal(await reminders.sendReminders({ now: now + 7 * day, send }), 1);
  assert.equal(sent.length, 2);

  // Attesting moves the due date on and stops the reminders.
  att.attest({ id: g, name: 'quarterly-review' }, { username: 'mona' }, '', now + 8 * day);
  sent.length = 0;
  assert.equal(await reminders.sendReminders({ now: now + 30 * day, send }), 0);
  assert.equal(sent.length, 0);
});

test('a group that is not yet due, and a manager without an email address, get no reminder', async () => {
  const now = 3_000_000;
  mkGroup('not-yet-due', [mona], now + 5 * day);
  const quiet = mkUser('quiet', '');
  mkGroup('no-email', [quiet], now - day);
  sent.length = 0;
  assert.equal(await reminders.sendReminders({ now, send }), 0);
  assert.equal(sent.length, 0);
});

test('a manager with several overdue groups gets one email listing all of them', async () => {
  const now = 5_000_000;
  const alpha = mkGroup('alpha', [mona], now - 2 * day);
  const beta = mkGroup('beta', [mona], now - 9 * day);
  sent.length = 0;
  await reminders.sendReminders({ now, send });
  const toMona = sent.filter((s) => s.to === 'mona@example.com');
  assert.equal(toMona.length, 1);
  assert.match(toMona[0].text, new RegExp(`- alpha \\(due [\\d-]+\\): .*/groups/${alpha}$`, 'm'));
  assert.match(toMona[0].text, new RegExp(`- beta \\(due [\\d-]+\\): .*/groups/${beta}$`, 'm'));
  assert.match(toMona[0].text, /Attest membership/);
});

test('nothing is sent when email is not configured', async () => {
  const now = 4_000_000;
  mkGroup('unconfigured', [mona], now - day);
  messaging.configured = () => false;
  try {
    sent.length = 0;
    assert.equal(await reminders.sendReminders({ now, send }), 0);
    assert.equal(sent.length, 0);
  } finally {
    messaging.configured = () => true;
  }
});
