const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { BUILTIN_ROLES } = require('./builtin-roles');
const { normalize } = require('./permissions');

const file = require('./settings').dbPath;
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const functionsTableExisted = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_functions'").get());

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  employee_id TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  upn TEXT NOT NULL DEFAULT '',
  sam_account_name TEXT NOT NULL DEFAULT '',
  distinguished_name TEXT NOT NULL DEFAULT '',
  mail_nickname TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  manager TEXT NOT NULL DEFAULT '',
  office TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  street_address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT NOT NULL DEFAULT '',
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_attributes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Membership of a Grouper group (by name) grants an IdP role.
CREATE TABLE IF NOT EXISTS grouper_role_map (
  group_name TEXT NOT NULL COLLATE NOCASE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (group_name, role_id)
);

-- Sign-in and password rules that apply to everyone holding a role or belonging to any of a set of groups. A policy targets
-- one role (role_id) or one or more groups (policy_groups); where several apply to a person the strictest value of each rule wins.
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  role_id INTEGER UNIQUE REFERENCES roles(id) ON DELETE CASCADE,
  block_sign_in INTEGER NOT NULL DEFAULT 0,
  require_mfa INTEGER NOT NULL DEFAULT 0,
  min_password_length INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS policy_groups (
  policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, group_id)
);

-- Reusable sets of password rules (password-rules.js). A policy above points at one with policies.password_policy_id.
CREATE TABLE IF NOT EXISTS password_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  min_length INTEGER NOT NULL DEFAULT 0,
  require_lowercase INTEGER NOT NULL DEFAULT 0,
  require_uppercase INTEGER NOT NULL DEFAULT 0,
  require_digit INTEGER NOT NULL DEFAULT 0,
  require_symbol INTEGER NOT NULL DEFAULT 0,
  min_character_classes INTEGER NOT NULL DEFAULT 0,
  block_personal_info INTEGER NOT NULL DEFAULT 0,
  restricted_words TEXT NOT NULL DEFAULT '[]',
  restricted_patterns TEXT NOT NULL DEFAULT '[]',
  history_count INTEGER NOT NULL DEFAULT 0,
  history_forbid_all INTEGER NOT NULL DEFAULT 0,
  hibp_enabled INTEGER NOT NULL DEFAULT 0,
  hibp_min_count INTEGER NOT NULL DEFAULT 1,
  hibp_block_on_error INTEGER NOT NULL DEFAULT 0,
  zxcvbn_enabled INTEGER NOT NULL DEFAULT 0,
  zxcvbn_min_score INTEGER NOT NULL DEFAULT 0
);

-- The hashes of a person's earlier passwords, newest last, kept so a password policy can refuse reuse.
CREATE TABLE IF NOT EXISTS password_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS password_history_user ON password_history (user_id, id);

CREATE TABLE IF NOT EXISTS service_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sp_entity_id TEXT NOT NULL DEFAULT '',
  acs_urls TEXT NOT NULL DEFAULT '[]',
  slo_url TEXT NOT NULL DEFAULT '',
  login_url TEXT NOT NULL DEFAULT '',
  default_relay_state TEXT NOT NULL DEFAULT '',
  nameid_format TEXT NOT NULL DEFAULT 'emailAddress',
  nameid_source TEXT NOT NULL DEFAULT 'email',
  signature_algorithm TEXT NOT NULL DEFAULT 'sha256',
  sign_response INTEGER NOT NULL DEFAULT 1,
  sign_assertion INTEGER NOT NULL DEFAULT 1,
  groups_attribute TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  metadata_mode TEXT NOT NULL DEFAULT 'none',
  metadata_url TEXT NOT NULL DEFAULT '',
  encrypt_assertion INTEGER NOT NULL DEFAULT 0,
  encryption_cert_pem TEXT NOT NULL DEFAULT '',
  encryption_algorithm TEXT NOT NULL DEFAULT 'aes256-cbc',
  key_transport_algorithm TEXT NOT NULL DEFAULT 'rsa-oaep-mgf1p',
  transform_enabled INTEGER NOT NULL DEFAULT 1,
  transform_rules TEXT NOT NULL DEFAULT '',
  transform_nameid_attr TEXT NOT NULL DEFAULT '',
  transform_temp_attrs TEXT NOT NULL DEFAULT '[]',
  private_key_pem TEXT NOT NULL,
  cert_pem TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sp_attribute_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sp_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  idp_attribute TEXT NOT NULL,
  saml_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sp_static_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sp_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sp_role_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sp_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  saml_name TEXT NOT NULL,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sp_access_groups (
  sp_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (sp_id, group_id)
);

CREATE TABLE IF NOT EXISTS sso_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL,
  sp_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  name_id TEXT NOT NULL,
  name_id_format TEXT NOT NULL,
  session_index TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- External directories: an LDAP/Active Directory server that users sign in against, and/or a REST API
-- (authenticated by a bearer token) through which an external system maintains the identities it owns.
CREATE TABLE IF NOT EXISTS directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL DEFAULT 'ldap',
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  token_hash TEXT NOT NULL DEFAULT '',
  token_created_at TEXT NOT NULL DEFAULT '',
  last_activity_at TEXT NOT NULL DEFAULT '',
  last_activity TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Provisioning feeds: an HR / ERP / SIS system of record that creates, updates and deprovisions the users a directory
-- owns (see provisioning.js). The state row remembers what the feed last decided about a person, so dates and
-- leavers take effect on time and an administrator's manual change is not undone by the next run.
CREATE TABLE IF NOT EXISTS provisioning_feeds (
  directory_id INTEGER PRIMARY KEY REFERENCES directories(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',
  last_pull_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provisioning_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  directory_id INTEGER NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
  src_active INTEGER NOT NULL DEFAULT 1,
  start_at INTEGER,
  end_at INTEGER,
  missing_since INTEGER,
  desired INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT '',
  inactive_since INTEGER
);
CREATE INDEX IF NOT EXISTS provisioning_state_directory ON provisioning_state (directory_id);

CREATE TABLE IF NOT EXISTS provisioning_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  directory_id INTEGER NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  via TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '{}',
  report TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS provisioning_runs_directory ON provisioning_runs (directory_id, id);

-- Opaque per-SP identifiers for persistent NameID, eduPersonTargetedID and pairwise-id. Stable once issued.
CREATE TABLE IF NOT EXISTS persistent_ids (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sp_entity_id TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, sp_entity_id)
);

-- People who signed in through another institution's IdP. The subject is the identifier that IdP gave them
-- (pairwise-id, subject-id, persistent ID or scoped ePPN); it is never matched to a local account by email.
CREATE TABLE IF NOT EXISTS federated_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idp_entity_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provisioned INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  attributes TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT NOT NULL DEFAULT '',
  UNIQUE (idp_entity_id, subject_type, subject)
);

-- Assertion IDs already accepted from an upstream IdP, kept until they could no longer validate (replay protection).
CREATE TABLE IF NOT EXISTS used_assertions (
  assertion_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Federation metadata: each source is a signed aggregate (e.g. InCommon) verified against a pinned certificate.
CREATE TABLE IF NOT EXISTS federation_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  signing_cert_pem TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  refresh_hours INTEGER NOT NULL DEFAULT 6,
  last_etag TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT NOT NULL DEFAULT '',
  last_success_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  entity_count INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS federation_entities (
  source_id INTEGER NOT NULL REFERENCES federation_sources(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  is_idp INTEGER NOT NULL DEFAULT 0,
  is_sp INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  valid_until TEXT NOT NULL DEFAULT '',
  parsed TEXT NOT NULL DEFAULT '{}',
  xml TEXT NOT NULL,
  PRIMARY KEY (source_id, entity_id)
);
CREATE INDEX IF NOT EXISTS federation_entities_entity ON federation_entities (entity_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);

-- Failed password and one-time-code attempts, kept here (not in the session) so starting a new sign-in does not reset the count.
CREATE TABLE IF NOT EXISTS auth_failures (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_key ON auth_failures (scope, key, ts);
`);

// Add columns to tables created by earlier versions.
function addMissingColumns(table, columns) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const [col, ddl] of columns) {
    if (!have.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
}

const TEXT = "TEXT NOT NULL DEFAULT ''";
// A guest is an account hosted by another user (guests.js). Deleting the host deletes their guests. expires_at (ISO time) is when the guest stops working.
addMissingColumns('users', [['host_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'], ['expires_at', 'TEXT']]);
// A sign-in policy may be less strict than the global policy only with an accepted override: global_override maps each weakened rule to the
// global value it was accepted against (policies.js), and the _by/_at columns record who accepted and when.
addMissingColumns('policies', [['global_override', 'TEXT'], ['global_override_by', 'TEXT'], ['global_override_at', 'TEXT']]);
// Federation sources: 'aggregate' is a bulk file refreshed on a schedule; 'mdq' is a per-entity query service whose answers are
// cached as they are needed. `roles` limits which entities an aggregate keeps ('all', 'idp' or 'sp').
addMissingColumns('federation_sources', [['kind', "TEXT NOT NULL DEFAULT 'aggregate'"], ['roles', "TEXT NOT NULL DEFAULT 'all'"]]);
// For entities fetched on demand: when they were fetched and when the cached copy should be asked for again.
addMissingColumns('federation_entities', [['fetched_at', TEXT], ['expires_at', TEXT]]);
addMissingColumns('users', [
  ['totp_secret', TEXT],
  ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['totp_last_step', 'INTEGER NOT NULL DEFAULT 0'],
  ...['upn', 'sam_account_name', 'distinguished_name', 'mail_nickname', 'company', 'manager', 'office', 'mobile',
    'street_address', 'city', 'state', 'postal_code', 'country', 'description'].map((c) => [c, TEXT]),
]);
addMissingColumns('service_providers', [
  ['description', TEXT],
  ['metadata_mode', "TEXT NOT NULL DEFAULT 'none'"],
  ['metadata_url', TEXT],
  ['encrypt_assertion', 'INTEGER NOT NULL DEFAULT 0'],
  ['encryption_cert_pem', TEXT],
  ['encryption_algorithm', "TEXT NOT NULL DEFAULT 'aes256-cbc'"],
  ['key_transport_algorithm', "TEXT NOT NULL DEFAULT 'rsa-oaep-mgf1p'"],
  ['transform_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['transform_rules', TEXT],
  ['transform_nameid_attr', TEXT],
  ['transform_temp_attrs', "TEXT NOT NULL DEFAULT '[]'"],
  ['access_mode', "TEXT NOT NULL DEFAULT 'all'"],
  ['grouper_groups', 'INTEGER NOT NULL DEFAULT 0'],
  ['signing_cert_pem', TEXT],
]);
// directory_id: the external directory that owns a user (NULL for local accounts); external_id is that
// directory's own identifier for them. Local accounts are never touched by a directory.
addMissingColumns('users', [
  ['directory_id', 'INTEGER REFERENCES directories(id) ON DELETE SET NULL'],
  ['external_id', TEXT],
]);
// Who last set the password and how: password_changed_by is the acting user's id (NULL when unknown or the system),
// password_changed_via is 'self', 'admin', 'recovery', 'api' or 'bulk'.
addMissingColumns('users', [
  ['password_changed_at', TEXT],
  ['password_changed_by', 'INTEGER'],
  ['password_changed_via', TEXT],
]);
// Set when an administrator tightens password rules and chooses to enforce them at once: the person must choose a new password before
// they can do anything else. Cleared by the next password change.
addMissingColumns('users', [['password_change_required', 'INTEGER NOT NULL DEFAULT 0']]);
// Organizational email addresses. users.email stays the primary address (SAML, LDAP and the directory API read it), and
// the triggers keep the two in step whichever side is written, so code that only knows users.email keeps working.
// Addresses are unique per person here; uniqueness across people is checked where an administrator edits them.
db.exec(`
CREATE TABLE IF NOT EXISTS user_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, email)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_emails_primary ON user_emails (user_id) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS user_emails_email ON user_emails (email);
INSERT OR IGNORE INTO user_emails (user_id, email, is_primary) SELECT id, email, 1 FROM users WHERE email != '';
CREATE TRIGGER IF NOT EXISTS users_email_insert AFTER INSERT ON users WHEN NEW.email != ''
  BEGIN INSERT OR IGNORE INTO user_emails (user_id, email, is_primary) VALUES (NEW.id, NEW.email, 1); END;
CREATE TRIGGER IF NOT EXISTS users_email_update AFTER UPDATE OF email ON users WHEN NEW.email != OLD.email
  BEGIN
    UPDATE user_emails SET is_primary = 0 WHERE user_id = NEW.id AND is_primary = 1;
    INSERT OR IGNORE INTO user_emails (user_id, email, is_primary) SELECT NEW.id, NEW.email, 0 WHERE NEW.email != '';
    UPDATE user_emails SET is_primary = 1 WHERE user_id = NEW.id AND email = NEW.email AND NEW.email != '';
  END;
`);
// Typed, administrator-defined user attributes (values live in user_attributes).
db.exec(`
CREATE TABLE IF NOT EXISTS attribute_defs (
  name TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'bool', 'date', 'enum')),
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  default_value TEXT NOT NULL DEFAULT ''
);
`);
// Bulk imports that were run (dry runs are not kept) and account actions set to happen later. Names are copied in so
// history outlives the people it mentions; schedules deliberately have no foreign keys for the same reason.
db.exec(`
CREATE TABLE IF NOT EXISTS bulk_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  on_error TEXT NOT NULL DEFAULT 'skip',
  total INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS user_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK (action IN ('create', 'activate', 'deactivate', 'delete')),
  run_at INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'group', 'new')),
  user_id INTEGER,
  group_id INTEGER,
  target_name TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  result TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  ran_at INTEGER
);
CREATE INDEX IF NOT EXISTS user_schedule_due ON user_schedule (status, run_at);

-- Bearer tokens for the user API (user-api.js). Only a hash is stored. scopes: space-separated, see user-api.js.
CREATE TABLE IF NOT EXISTS user_api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL DEFAULT ''
);

-- Extra sign-in factors beyond the authenticator app (which stays on the users row): FIDO2 security keys and passkeys
-- ('webauthn') and email, SMS or voice delivery ('email', 'sms', 'voice'). destination is the address or number; for a
-- key, credential holds its public key and signature counter and credential_id its id. An unverified factor is not used.
CREATE TABLE IF NOT EXISTS user_factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('webauthn', 'email', 'sms', 'voice')),
  label TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  credential_id TEXT,
  credential TEXT NOT NULL DEFAULT '{}',
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS user_factors_user ON user_factors (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_factors_credential ON user_factors (credential_id) WHERE credential_id IS NOT NULL;

-- A code or approval sent to an email address, phone or call. mode 'code': the person types the code into the sign-in page
-- (only its hash is kept). mode 'number_match': the sign-in page shows display_number and the person enters it on the device
-- that received the message, so nothing typed on the sign-in page can be phished. purpose 'login' or 'verify' (adding a factor).
CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  factor_id INTEGER NOT NULL REFERENCES user_factors(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'login',
  mode TEXT NOT NULL,
  code_hash TEXT NOT NULL DEFAULT '',
  display_number TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'consumed', 'failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS otp_challenges_token ON otp_challenges (token_hash);
CREATE INDEX IF NOT EXISTS otp_challenges_factor ON otp_challenges (factor_id, created_at);

-- Identity verifications started for a self-service reset (identity/index.js): a person's check with the provider (Persona, a REST
-- service or an integration script), its reference there, and the status last seen. Statuses other than pending are final.
CREATE TABLE IF NOT EXISTS identity_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'error')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS identity_verifications_user ON identity_verifications (user_id, purpose, created_at);
CREATE INDEX IF NOT EXISTS identity_verifications_ref ON identity_verifications (ref);

-- Password recovery by link to a personal email address (recovery.js). Only a hash of the link's token is stored; a token works
-- once, for 30 minutes. Any password change deletes the user's outstanding tokens.
CREATE TABLE IF NOT EXISTS recovery_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS recovery_tokens_user ON recovery_tokens (user_id, created_at);

-- Every step of signing in, with where it came from, for investigating an incident and for risk decisions (authlog.js).
-- type: 'password' (a credential check), 'mfa' (a second-factor step), 'signin' (a sign-in completed, or was refused after the
-- password was right), 'recovery'. Names and places are copied in so rows outlive the account. device_id is the first 12
-- characters of the hash of the browser's device cookie, never the cookie itself.
CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  username TEXT NOT NULL DEFAULT '',
  factor TEXT NOT NULL DEFAULT '',
  amr TEXT NOT NULL DEFAULT '[]',
  ip TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  country_name TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  asn INTEGER,
  asn_org TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  device_known INTEGER,
  user_agent TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '',
  device_lat REAL,
  device_lon REAL,
  risk_score INTEGER,
  risk_level TEXT NOT NULL DEFAULT '',
  risk_reasons TEXT NOT NULL DEFAULT '[]',
  risk_action TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS auth_events_user ON auth_events (user_id, ts);
CREATE INDEX IF NOT EXISTS auth_events_ip ON auth_events (ip, ts);
CREATE INDEX IF NOT EXISTS auth_events_name ON auth_events (username, ts);
CREATE INDEX IF NOT EXISTS auth_events_kind ON auth_events (type, outcome, ts);

-- Remembers the outcome of a POST for 24 hours so a client that retries with the same Idempotency-Key gets the same answer
-- instead of a second account.
CREATE TABLE IF NOT EXISTS api_idempotency (
  token_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, key)
);
`);
// Sign-in factor rules on a policy: allowed_factors is a comma-separated list (empty = no limit) and
// require_phishing_resistant limits sign-in to factors that cannot be phished.
// What risk-based sign-in does at a medium or high score for the people a policy covers (''  = nothing beyond the global setting).
addMissingColumns('policies', [['risk_medium_action', TEXT], ['risk_high_action', TEXT]]);
// How long a second factor counts for a browser after it was completed (hours). Empty = no rule; 0 = always ask.
addMissingColumns('policies', [['remember_mfa_hours', 'INTEGER']]);
addMissingColumns('recovery_tokens', [['purpose', "TEXT NOT NULL DEFAULT 'password'"]]);
addMissingColumns('policies', [['password_policy_id', 'INTEGER REFERENCES password_policies(id)'], ['allowed_factors', TEXT], ['require_phishing_resistant', 'INTEGER NOT NULL DEFAULT 0'], ['disable_password_recovery', 'INTEGER NOT NULL DEFAULT 0']]);
// A personal (non-organizational) email address used only to recover a forgotten password. Not part of the profile fields, so it is
// never released to applications or shown in the directory API.
addMissingColumns('users', [['personal_email', TEXT], ['personal_email_verified', 'INTEGER NOT NULL DEFAULT 0']]);
// The person's color theme: 'light', 'dark' or 'system' (follow the operating system). Used on every device they sign in from.
addMissingColumns('users', [['color_mode', "TEXT NOT NULL DEFAULT 'system'"]]);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_directory_external ON users (directory_id, external_id) WHERE external_id != ''");
// Memberships of Grouper groups: pinned = an administrator added the user (Grouper can never remove it),
// via_grouper = Grouper provides it. A row stays while either is set.
addMissingColumns('group_members', [
  ['pinned', 'INTEGER NOT NULL DEFAULT 0'],
  ['via_grouper', 'INTEGER NOT NULL DEFAULT 0'],
  ['via_rule', 'INTEGER NOT NULL DEFAULT 0'],
]);
// source: 'local' groups are edited in the console; 'grouper' groups are provisioned by Internet2 Grouper over SCIM;
// 'directory' groups come from an external directory (directory_id) and are read-only in the console.
addMissingColumns('groups', [
  ['source', "TEXT NOT NULL DEFAULT 'local'"],
  ['external_id', TEXT],
  ['directory_id', 'INTEGER REFERENCES directories(id) ON DELETE CASCADE'],
]);

// Built-in group management: membership windows (epoch seconds, NULL = open-ended), nested groups and composites.
addMissingColumns('group_members', [
  ['start_at', 'INTEGER'],
  ['end_at', 'INTEGER'],
]);
db.exec(`
CREATE TABLE IF NOT EXISTS group_includes (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, member_group_id),
  CHECK (group_id != member_group_id)
);

-- A composite group's members are op(left, right) over the factors' effective members: union, intersect or minus.
CREATE TABLE IF NOT EXISTS group_composites (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK (op IN ('union', 'intersect', 'minus')),
  left_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  right_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE
);

-- Grouper-style include and exclude groups of a local group. Its effective members are its own, plus the include group's,
-- minus the exclude group's. Both are ordinary local groups (named <group>:include and <group>:exclude) that the base owns:
-- they are removed with it.
CREATE TABLE IF NOT EXISTS group_include_exclude (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  include_id INTEGER NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
  exclude_id INTEGER NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
  CHECK (include_id != exclude_id AND include_id != group_id AND exclude_id != group_id)
);

-- An LDAP query that decides who is a direct member of a local group (group-rules.js). 'snapshot' runs once when asked and
-- adds the matching people as ordinary members; 'ongoing' keeps the members it added (group_members.via_rule = 1) in step with the query.
CREATE TABLE IF NOT EXISTS group_rules (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  filter TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'ongoing')),
  last_run_at INTEGER,
  last_added INTEGER NOT NULL DEFAULT 0,
  last_removed INTEGER NOT NULL DEFAULT 0,
  last_matched INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  set_by TEXT NOT NULL DEFAULT '',
  set_at INTEGER NOT NULL
);

-- Who changed a group and how. group_name is kept so entries outlive a deleted group.
CREATE TABLE IF NOT EXISTS group_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  group_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS group_audit_group ON group_audit (group_id, id);

-- Central, append-only audit trail of system, administrator and user events. Actor and target names are
-- copied in so entries outlive the users and objects they describe. Only the retention pruner deletes.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success',
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  target_name TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts);
CREATE INDEX IF NOT EXISTS audit_log_category ON audit_log (category, ts);
CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log (actor_id, ts);
CREATE INDEX IF NOT EXISTS audit_log_target ON audit_log (target_type, target_id, ts);

-- How far each external log sink (syslog, HTTP, ...) has been sent, so events are replayed after an outage.
CREATE TABLE IF NOT EXISTS audit_forward_state (
  sink TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0
);

-- Each cutover to Grouper, with what it removed, so it can be reverted.
CREATE TABLE IF NOT EXISTS grouper_cutover (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  reverted_at INTEGER
);

-- Delegated group administration. subject_id is a users.id or groups.id (per subject_type); triggers below
-- remove grants when their subject is deleted. Management privileges nest: admin > update > read > view.
-- optin / optout are separate: they let the subject add or remove only themselves, and may be granted to
-- 'everyone' (subject_id 0).
CREATE TABLE IF NOT EXISTS group_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group', 'everyone')),
  subject_id INTEGER NOT NULL,
  privilege TEXT NOT NULL CHECK (privilege IN ('admin', 'update', 'read', 'view', 'optin', 'optout')),
  CHECK (subject_type != 'everyone' OR (privilege IN ('optin', 'optout') AND subject_id = 0)),
  UNIQUE (group_id, subject_type, subject_id, privilege)
);
CREATE TRIGGER IF NOT EXISTS group_admins_user_deleted AFTER DELETE ON users
  BEGIN DELETE FROM group_admins WHERE subject_type = 'user' AND subject_id = OLD.id; END;
CREATE TRIGGER IF NOT EXISTS group_admins_group_deleted AFTER DELETE ON groups
  BEGIN DELETE FROM group_admins WHERE subject_type = 'group' AND subject_id = OLD.id; END;

-- Group managers: people responsible for a group's membership. A manager can change members and attests that the
-- membership is still correct. Set by an administrator or anyone with the admin privilege on the group.
CREATE TABLE IF NOT EXISTS group_managers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  UNIQUE (group_id, user_id)
);

-- How often a group's managers must attest to its membership, and when the next attestation is due.
CREATE TABLE IF NOT EXISTS group_attestation_policy (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'annually')),
  next_due INTEGER NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL
);

-- Each attestation, with the people who were members at the time. Kept (by name) after the group is deleted.
CREATE TABLE IF NOT EXISTS group_attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  group_name TEXT NOT NULL,
  ts INTEGER NOT NULL,
  attested_by TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  members TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS group_attestations_group ON group_attestations (group_id, id);
`);
// When managers were last emailed that an overdue attestation is still owed. Cleared by an attestation.
addMissingColumns('group_attestation_policy', [['last_reminder_at', 'INTEGER']]);

// Databases created before self-service have a CHECK that rejects optin / optout, and SQLite cannot alter a CHECK,
// so rebuild the table. The triggers go first: renaming a table fails while a trigger names a table that is missing.
function migrateGroupAdmins() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'group_admins'").get();
  if (!row || row.sql.includes("'everyone'")) return false;
  try {
    db.exec(`
BEGIN;
DROP TRIGGER IF EXISTS group_admins_user_deleted;
DROP TRIGGER IF EXISTS group_admins_group_deleted;
CREATE TABLE group_admins_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group', 'everyone')),
  subject_id INTEGER NOT NULL,
  privilege TEXT NOT NULL CHECK (privilege IN ('admin', 'update', 'read', 'view', 'optin', 'optout')),
  CHECK (subject_type != 'everyone' OR (privilege IN ('optin', 'optout') AND subject_id = 0)),
  UNIQUE (group_id, subject_type, subject_id, privilege)
);
INSERT INTO group_admins_new (id, group_id, subject_type, subject_id, privilege)
  SELECT id, group_id, subject_type, subject_id, privilege FROM group_admins;
DROP TABLE group_admins;
ALTER TABLE group_admins_new RENAME TO group_admins;
CREATE TRIGGER group_admins_user_deleted AFTER DELETE ON users
  BEGIN DELETE FROM group_admins WHERE subject_type = 'user' AND subject_id = OLD.id; END;
CREATE TRIGGER group_admins_group_deleted AFTER DELETE ON groups
  BEGIN DELETE FROM group_admins WHERE subject_type = 'group' AND subject_id = OLD.id; END;
COMMIT;`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction was open */ }
    throw e;
  }
  return true;
}
migrateGroupAdmins();

db.exec(`UPDATE group_members SET via_grouper = 1 WHERE pinned = 0 AND via_grouper = 0
         AND group_id IN (SELECT id FROM groups WHERE source = 'grouper')`);

// Built-in roles. Administrator holds every permission and cannot be edited.
db.exec(`INSERT OR IGNORE INTO roles (key, name, description)
         VALUES ('admin', 'Administrator', 'Full access to the admin console.')`);

// Job roles from builtin-roles.js, created once. The marker keeps a role an administrator deleted from coming back
// on restart, and a custom role that already uses the name is left alone.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'builtin_roles_seeded'").get()) {
  for (const r of BUILTIN_ROLES) {
    if (db.prepare('SELECT 1 FROM roles WHERE key = ? OR name = ? COLLATE NOCASE').get(r.key, r.name)) continue;
    const { lastInsertRowid } = db.prepare('INSERT INTO roles (key, name, description) VALUES (?, ?, ?)').run(r.key, r.name, r.description);
    for (const p of normalize(r.permissions)) {
      db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').run(lastInsertRowid, p);
    }
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('builtin_roles_seeded', 'true')").run();
}

// Earlier versions flagged administrators with users.is_admin; move them onto the role.
if (db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'is_admin')) {
  db.exec(`INSERT OR IGNORE INTO user_roles (user_id, role_id)
           SELECT u.id, r.id FROM users u, roles r WHERE u.is_admin = 1 AND r.key = 'admin';
           ALTER TABLE users DROP COLUMN is_admin;`);
}

// Folders organize groups in the console. They are purely organizational: a group's name, membership and what it
// grants do not depend on where it is filed. position orders siblings (0 = never arranged, so by name).
db.exec(`
CREATE TABLE IF NOT EXISTS group_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES group_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS group_folders_sibling_name ON group_folders (COALESCE(parent_id, 0), name);

CREATE TRIGGER IF NOT EXISTS group_folders_no_loop BEFORE UPDATE OF parent_id ON group_folders
  WHEN NEW.parent_id IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'A folder cannot be moved into itself or one of its subfolders.')
    WHERE NEW.parent_id = NEW.id OR EXISTS (
      WITH RECURSIVE up(id) AS (
        SELECT NEW.parent_id UNION ALL SELECT f.parent_id FROM group_folders f JOIN up ON f.id = up.id WHERE f.parent_id IS NOT NULL)
      SELECT 1 FROM up WHERE id = NEW.id);
  END;

-- Deleting a folder keeps what it holds: its groups and subfolders move up to its parent.
CREATE TRIGGER IF NOT EXISTS group_folders_reparent BEFORE DELETE ON group_folders
  BEGIN
    UPDATE groups SET folder_id = OLD.parent_id WHERE folder_id = OLD.id;
    UPDATE group_folders SET parent_id = OLD.parent_id WHERE parent_id = OLD.id;
  END;

-- Bearer tokens for the group management API (group-api.js). Only a hash is stored. scope: 'read' or 'write'.
CREATE TABLE IF NOT EXISTS group_api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL DEFAULT ''
);

-- CAS, OpenID Connect and OAuth 2.0 applications (apps.js). \`redirect_uris\` holds a CAS app's service URL patterns.
-- client_secret_hash is empty for a public client (and for CAS). The list columns are JSON arrays.
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL CHECK (protocol IN ('cas', 'oidc', 'oauth2')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  client_id TEXT UNIQUE,
  client_secret_hash TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  post_logout_uris TEXT NOT NULL DEFAULT '[]',
  grant_types TEXT NOT NULL DEFAULT '[]',
  scopes TEXT NOT NULL DEFAULT '[]',
  require_pkce INTEGER NOT NULL DEFAULT 1,
  subject_source TEXT NOT NULL DEFAULT 'guid',
  access_token_ttl INTEGER NOT NULL DEFAULT 3600,
  access_mode TEXT NOT NULL DEFAULT 'all',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_attribute_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  idp_attribute TEXT NOT NULL,
  claim_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_access_groups (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (app_id, group_id)
);

-- Short-lived protocol artifacts: authorization codes, access and refresh tokens, CAS tickets. Only a hash of the value is
-- stored. kind: 'code' | 'access' | 'refresh' | 'ticket'. user_id is NULL for client-credentials tokens.
CREATE TABLE IF NOT EXISTS app_grants (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL DEFAULT '',
  nonce TEXT NOT NULL DEFAULT '',
  code_challenge TEXT NOT NULL DEFAULT '',
  auth_time INTEGER NOT NULL DEFAULT 0,
  amr TEXT NOT NULL DEFAULT '[]',
  fresh INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_grants_expiry ON app_grants (expires_at);

-- Integrations (integrations/): an administrator's script, what it may touch (scopes: space-separated, see
-- integrations/host.js), and an optional webhook so outside software can start it. Only a hash of the webhook token is kept.
CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  script TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  timeout_seconds INTEGER NOT NULL DEFAULT 10,
  webhook_token_hash TEXT NOT NULL DEFAULT '',
  webhook_token_created_at TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- An integration's time-based triggers: any number per integration (see integrations/schedule.js for the shapes). next_run_at
-- is '' once a schedule has ended.
CREATE TABLE IF NOT EXISTS integration_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL,
  next_run_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS integration_schedules_by_integration ON integration_schedules (integration_id, id);
CREATE INDEX IF NOT EXISTS integration_schedules_due ON integration_schedules (next_run_at);

-- Variables scripts read as vars.NAME: endpoints, API keys and other values that should not be pasted into code.
-- A secret's value is never shown again in the console and is blanked from run output.
CREATE TABLE IF NOT EXISTS integration_variables (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  secret INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- What each run did. trigger: 'manual' | 'webhook' | 'schedule' | 'event' | 'test'. status: 'ok' | 'error' | 'timeout'.
CREATE TABLE IF NOT EXISTS integration_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL DEFAULT '',
  input TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  logs TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS integration_runs_by_integration ON integration_runs (integration_id, id);

-- The files module (src/files/store.js): every file and folder that integrations, the SFTP server and administrators keep.
-- A folder is a row with kind 'dir' and no content, so an empty one exists. parent is the folder above ('/' for the top level,
-- '' for the top level itself). Saved integration logs are files here too, under /logs (src/files/logs.js).
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  parent TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  size INTEGER NOT NULL DEFAULT 0,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS files_by_parent ON files (parent, path);

-- Accounts for other software that reaches the files module over SFTP (src/service-accounts.js, src/files/sftp-server.js).
-- They are not people: they sign in with a password or an SSH public key, and see only the directories in grants.
-- grants is a JSON list of { path, access }; access is read, write or readwrite.
CREATE TABLE IF NOT EXISTS service_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL DEFAULT '',
  public_keys TEXT NOT NULL DEFAULT '[]',
  grants TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- Groups whose members may run an integration (without being able to edit it). Empty means only people who manage integrations.
CREATE TABLE IF NOT EXISTS integration_run_groups (
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (integration_id, group_id)
);

-- Functions an administrator writes once, and any integration calls as fn.NAME({ ... }) (integrations/functions.js). The script is
-- the body of an async function; its inputs (JSON, see integrations/inputs.js) name the keys of the object it receives, and the
-- variables the code reads them into. It runs inside the calling integration's run, with that integration's scopes.
CREATE TABLE IF NOT EXISTS integration_functions (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- Reports (reports/): JavaScript an administrator writes to read data out of the IdP. Only the script is kept, never what it
-- returned; the pre-built reports live in code. A report runs with the permissions of whoever runs it.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  timeout_seconds INTEGER NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- Application policies (app-policies.js): what sign-in must look like before an application or SAML service provider
-- is given a sign-in. Several policies can name the same application; the strictest of each rule applies.
CREATE TABLE IF NOT EXISTS app_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  require_mfa INTEGER NOT NULL DEFAULT 0,
  require_phishing_resistant INTEGER NOT NULL DEFAULT 0,
  allowed_factors TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS app_policy_apps (
  policy_id INTEGER NOT NULL REFERENCES app_policies(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, app_id)
);
CREATE TABLE IF NOT EXISTS app_policy_sps (
  policy_id INTEGER NOT NULL REFERENCES app_policies(id) ON DELETE CASCADE,
  sp_id TEXT NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, sp_id)
);

-- The second factor a browser completed, kept so a person can skip it again for the policy's remember period (mfa-remember.js).
-- One row per person and browser; it is replaced by the next second factor and removed when the person asks to be asked again.
CREATE TABLE IF NOT EXISTS mfa_remembered (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  factor_id TEXT NOT NULL,
  factor_type TEXT NOT NULL,
  amr TEXT NOT NULL DEFAULT '[]',
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- What a compromised-account lockdown does (compromise.js). The Everyone policy (everyone = 1) sets the default procedure for every
-- account; a role policy (role_id) or group policy (compromise_policy_groups) adds to it, and the strictest value of each step wins.
CREATE TABLE IF NOT EXISTS compromise_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  everyone INTEGER NOT NULL DEFAULT 0,
  role_id INTEGER UNIQUE REFERENCES roles(id) ON DELETE CASCADE,
  end_sessions INTEGER NOT NULL DEFAULT 1,
  reset_password INTEGER NOT NULL DEFAULT 1,
  rotate_mfa INTEGER NOT NULL DEFAULT 1,
  forget_remembered INTEGER NOT NULL DEFAULT 1,
  lock_account INTEGER NOT NULL DEFAULT 1,
  notify_user INTEGER NOT NULL DEFAULT 1,
  restrict_networks TEXT NOT NULL DEFAULT '',
  add_to_group INTEGER NOT NULL DEFAULT 0,
  add_to_group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  CHECK (everyone = 0 OR role_id IS NULL)
);
CREATE TABLE IF NOT EXISTS compromise_policy_groups (
  policy_id INTEGER NOT NULL REFERENCES compromise_policies(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, group_id)
);

-- An account currently in lockdown. Its sign-in is refused from outside the networks (a JSON array of allowed-address lists; every
-- list must match). locked_account is 1 when the lockdown turned the account off, so ending it turns the account back on.
CREATE TABLE IF NOT EXISTS account_lockdowns (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL DEFAULT '',
  policy_names TEXT NOT NULL DEFAULT '[]',
  networks TEXT NOT NULL DEFAULT '[]',
  locked_account INTEGER NOT NULL DEFAULT 0
);
`);

// The lockdown step that adds the person to a group (compromise.js): on or off, and which group.
addMissingColumns('compromise_policies', [['add_to_group', 'INTEGER NOT NULL DEFAULT 0'], ['add_to_group_id', 'INTEGER REFERENCES groups(id) ON DELETE SET NULL']]);
// Databases from before a policy could name several groups keep one group_id on the policy, which SQLite cannot drop along with its
// UNIQUE and CHECK, so rebuild the table and move each group into the join table.
function migratePolicyGroups(table, joinTable, columns) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'group_id')) return;
  const keep = columns.filter((c) => !c.startsWith('CHECK')).map((c) => c.split(' ')[0]);
  const pairs = db.prepare(`SELECT id, group_id FROM ${table} WHERE group_id IS NOT NULL`).all();
  db.exec('BEGIN');
  try {
    // Renaming re-reads every trigger, so both must be gone while either table is rebuilt.
    db.exec('DROP TRIGGER IF EXISTS policy_groups_emptied; DROP TRIGGER IF EXISTS compromise_policy_groups_emptied');
    db.exec(`CREATE TABLE ${table}_new (${columns.join(', ')})`);
    db.exec(`INSERT INTO ${table}_new (${keep.join(', ')}) SELECT ${keep.map((c) => (c === 'everyone' ? '(role_id IS NULL AND group_id IS NULL)' : c)).join(', ')} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    for (const p of pairs) db.prepare(`INSERT OR IGNORE INTO ${joinTable} (policy_id, group_id) VALUES (?, ?)`).run(p.id, p.group_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
migratePolicyGroups('policies', 'policy_groups', [
  'id INTEGER PRIMARY KEY AUTOINCREMENT', 'name TEXT NOT NULL UNIQUE COLLATE NOCASE', "description TEXT NOT NULL DEFAULT ''",
  'role_id INTEGER UNIQUE REFERENCES roles(id) ON DELETE CASCADE', 'block_sign_in INTEGER NOT NULL DEFAULT 0', 'require_mfa INTEGER NOT NULL DEFAULT 0',
  'min_password_length INTEGER NOT NULL DEFAULT 0', `risk_medium_action ${TEXT}`, `risk_high_action ${TEXT}`, 'remember_mfa_hours INTEGER',
  'password_policy_id INTEGER REFERENCES password_policies(id)', `allowed_factors ${TEXT}`, 'require_phishing_resistant INTEGER NOT NULL DEFAULT 0',
  'disable_password_recovery INTEGER NOT NULL DEFAULT 0', 'global_override TEXT', 'global_override_by TEXT', 'global_override_at TEXT',
]);
migratePolicyGroups('compromise_policies', 'compromise_policy_groups', [
  'id INTEGER PRIMARY KEY AUTOINCREMENT', 'name TEXT NOT NULL UNIQUE COLLATE NOCASE', "description TEXT NOT NULL DEFAULT ''",
  'everyone INTEGER NOT NULL DEFAULT 0', 'role_id INTEGER UNIQUE REFERENCES roles(id) ON DELETE CASCADE',
  'end_sessions INTEGER NOT NULL DEFAULT 1', 'reset_password INTEGER NOT NULL DEFAULT 1', 'rotate_mfa INTEGER NOT NULL DEFAULT 1',
  'forget_remembered INTEGER NOT NULL DEFAULT 1', 'lock_account INTEGER NOT NULL DEFAULT 1', 'notify_user INTEGER NOT NULL DEFAULT 1',
  "restrict_networks TEXT NOT NULL DEFAULT ''", 'add_to_group INTEGER NOT NULL DEFAULT 0',
  'add_to_group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL', 'CHECK (everyone = 0 OR role_id IS NULL)',
]);
// Created after the rebuild above, because renaming a table fails while a trigger names a table that is missing.
db.exec(`
-- A group policy whose last group is deleted has nobody left to apply to, so it goes too (a role policy goes with its role).
CREATE TRIGGER IF NOT EXISTS policy_groups_emptied AFTER DELETE ON policy_groups
  WHEN NOT EXISTS (SELECT 1 FROM policy_groups WHERE policy_id = OLD.policy_id)
  BEGIN DELETE FROM policies WHERE id = OLD.policy_id AND role_id IS NULL; END;
CREATE TRIGGER IF NOT EXISTS compromise_policy_groups_emptied AFTER DELETE ON compromise_policy_groups
  WHEN NOT EXISTS (SELECT 1 FROM compromise_policy_groups WHERE policy_id = OLD.policy_id)
  BEGIN DELETE FROM compromise_policies WHERE id = OLD.policy_id AND everyone = 0 AND role_id IS NULL; END;
`);
// A report is a script ('script') or a definition built without code ('builder', see reports/builder.js).
addMissingColumns('reports', [['kind', "TEXT NOT NULL DEFAULT 'script'"], ['definition', "TEXT NOT NULL DEFAULT ''"]]);
addMissingColumns('integration_runs', [['output', "TEXT NOT NULL DEFAULT '[]'"]]);
// Service-account lockdown (service-accounts.js): whether it is in lockdown, when and by whom, whether it was enabled before, and the SSH keys
// suspended while it is in lockdown.
addMissingColumns('service_accounts', [
  ['locked_down', 'INTEGER NOT NULL DEFAULT 0'], ['lockdown_started_at', "TEXT NOT NULL DEFAULT ''"], ['lockdown_started_by', "TEXT NOT NULL DEFAULT ''"],
  ['lockdown_enabled_before', 'INTEGER NOT NULL DEFAULT 1'], ['suspended_keys', "TEXT NOT NULL DEFAULT '[]'"],
]);

// event_inputs: the value each input of an event trigger is given, or the event field it takes (integrations/inputs.js).
addMissingColumns('integrations', [['events', "TEXT NOT NULL DEFAULT ''"], ['inputs', "TEXT NOT NULL DEFAULT '[]'"], ['event_inputs', "TEXT NOT NULL DEFAULT '[]'"]]);
// logging: this integration's own logging settings as JSON, or '' to follow the global ones. api_enabled: the user API may run it.
// builtin: the key of the integration that shipped with the product ('' for one an administrator wrote).
addMissingColumns('integrations', [['logging', "TEXT NOT NULL DEFAULT ''"], ['api_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['builtin', "TEXT NOT NULL DEFAULT ''"]]);
addMissingColumns('integration_functions', [['inputs', "TEXT NOT NULL DEFAULT '[]'"]]);
// file_dirs: the directories of the files module this integration may use besides its own folder, as JSON grants.
addMissingColumns('integrations', [['file_dirs', "TEXT NOT NULL DEFAULT '[]'"]]);
// home_dir: the folder of the files module that relative paths in the script are in, or '' for the integration's own folder.
addMissingColumns('integrations', [['home_dir', "TEXT NOT NULL DEFAULT ''"]]);
// node: the server that ran it. finished_at: when it ended ('' while it is running; status is 'running' until then).
addMissingColumns('integration_runs', [['node', "TEXT NOT NULL DEFAULT ''"], ['finished_at', "TEXT NOT NULL DEFAULT ''"]]);

// Files an integration kept in integration_files move to the files module, each into the integration's own folder
// (/integrations/integration-<id>/<name>), and the table is dropped. Runs once: a database without the table has nothing to move.
function migrateIntegrationFiles() {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_files'").get()) return;
  try {
    db.exec('BEGIN');
    db.exec(`
INSERT OR IGNORE INTO files (path, parent, kind, size, content, created_at, updated_at, updated_by)
  SELECT '/integrations', '/', 'dir', 0, x'', COALESCE(MIN(updated_at), ''), COALESCE(MIN(updated_at), ''), '' FROM integration_files;
INSERT OR IGNORE INTO files (path, parent, kind, size, content, created_at, updated_at, updated_by)
  SELECT '/integrations/integration-' || integration_id, '/integrations', 'dir', 0, x'', MIN(updated_at), MIN(updated_at), '' FROM integration_files GROUP BY integration_id;
INSERT OR IGNORE INTO files (path, parent, kind, size, content, created_at, updated_at, updated_by)
  SELECT '/integrations/integration-' || integration_id || '/' || name, '/integrations/integration-' || integration_id, 'file', size, content, updated_at, updated_at, updated_by FROM integration_files;
DROP TABLE integration_files;`);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction was open */ }
    throw e;
  }
}
migrateIntegrationFiles();

// Integrations used to hold a single schedule in their own row. Move each one into integration_schedules, then drop the columns.
function migrateIntegrationSchedules() {
  if (!db.prepare('PRAGMA table_info(integrations)').all().some((c) => c.name === 'schedule')) return;
  try {
    db.exec(`
BEGIN;
INSERT INTO integration_schedules (integration_id, schedule, next_run_at, created_at)
  SELECT id, schedule, next_run_at, created_at FROM integrations WHERE schedule != '';
ALTER TABLE integrations DROP COLUMN next_run_at;
ALTER TABLE integrations DROP COLUMN schedule;
COMMIT;`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction was open */ }
    throw e;
  }
}
migrateIntegrationSchedules();

// The starter functions are added the first time their table is created. One an administrator deletes stays deleted.
if (!functionsTableExisted) {
  const now = new Date().toISOString();
  const add = db.prepare('INSERT INTO integration_functions (name, description, script, inputs, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?)');
  for (const f of require('./integrations/starter-functions')) add.run(f.name, f.description, f.script, JSON.stringify(f.inputs), now, 'starter', now);
}
// A starter nobody has edited (updated_at is still its created_at) takes the definition shipped now, so its body and inputs match
// this version. An edited one is left as it is.
const starterUpdate = db.prepare("UPDATE integration_functions SET description = ?, script = ?, inputs = ? WHERE name = ? AND created_by = 'starter' AND updated_at = created_at");
for (const f of require('./integrations/starter-functions')) starterUpdate.run(f.description, f.script, JSON.stringify(f.inputs), f.name);
addMissingColumns('groups', [
  ['folder_id', 'INTEGER REFERENCES group_folders(id) ON DELETE SET NULL'],
  ['position', 'INTEGER NOT NULL DEFAULT 0'],
]);

// Font files for the branding (src/fonts.js): one row per face, and per unicode-range subset for fonts from Google.
db.exec(`
CREATE TABLE IF NOT EXISTS font_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family TEXT NOT NULL,
  style TEXT NOT NULL,
  weight INTEGER NOT NULL,
  unicode_range TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL,
  source TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS font_files_face ON font_files (family, style, weight, unicode_range);
-- Images uploaded for the sign-in page (src/assets.js), referred to by file name from the page's HTML and CSS.
CREATE TABLE IF NOT EXISTS site_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
`);

const all =(sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

// A transaction started inside another joins it, so a caller that needs several steps to succeed or fail together can wrap
// helpers that open their own.
let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

// SQL views external software can read and write directly (see group-sql.js).
require('./group-sql').install(db);

module.exports = { db, all, get, run, tx, migrateGroupAdmins };
