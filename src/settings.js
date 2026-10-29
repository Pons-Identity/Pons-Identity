const fs = require('fs');
const path = require('path');

// Startup settings: defaults < config.json (or $CONFIG_FILE) < environment variables.
const root = path.join(__dirname, '..');
const file = path.resolve(root, process.env.CONFIG_FILE || 'config.json');

const defaults = {
  protocol: 'http',
  hostname: 'localhost',
  port: 3000,
  bindAddress: '0.0.0.0',
  baseUrl: '',
  dbPath: 'data/idp.db',
  adminPassword: '',
  sessionSecret: '',
  trustProxy: false,
  // Show the first-run setup wizard when the database has no users. Turn off (or set adminPassword) for unattended installs.
  setupWizard: true,
  tls: null,
  tlsCertFile: '',
  tlsKeyFile: '',
  httpRedirectPort: 0,
  // Optional Duo second factor (Auth API). Enabled only when all three are set.
  duoApiHost: '',
  duoIntegrationKey: '',
  duoSecretKey: '',
  // Audit log. Rows older than auditRetentionDays are pruned (0 keeps everything). Syslog and SIEM destinations
  // are configured in the console (Settings > Log forwarding). auditStdout: true prints one JSON line per event,
  // for container log shippers.
  auditRetentionDays: 365,
  auditStdout: false,
};

let fromFile = {};
if (fs.existsSync(file)) {
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${file}: ${e.message}`);
  }
}

const env = process.env;
const s = { ...defaults, ...fromFile };
if (env.PROTOCOL) s.protocol = env.PROTOCOL;
if (env.TLS) s.tls = env.TLS === 'true' || env.TLS === '1';
if (env.PORT) s.port = Number(env.PORT);
if (env.BIND_ADDRESS) s.bindAddress = env.BIND_ADDRESS;
if (env.BASE_URL) s.baseUrl = env.BASE_URL;
if (env.DB_PATH) s.dbPath = env.DB_PATH;
if (env.ADMIN_PASSWORD) s.adminPassword = env.ADMIN_PASSWORD;
if (env.SESSION_SECRET) s.sessionSecret = env.SESSION_SECRET;
if (env.TLS_CERT_FILE) s.tlsCertFile = env.TLS_CERT_FILE;
if (env.TLS_KEY_FILE) s.tlsKeyFile = env.TLS_KEY_FILE;
if (env.HTTP_REDIRECT_PORT) s.httpRedirectPort = Number(env.HTTP_REDIRECT_PORT);
if (env.SETUP_WIZARD) s.setupWizard = env.SETUP_WIZARD === 'true' || env.SETUP_WIZARD === '1';
if (env.TRUST_PROXY) s.trustProxy = env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1';
if (env.DUO_API_HOST) s.duoApiHost = env.DUO_API_HOST;
if (env.DUO_IKEY) s.duoIntegrationKey = env.DUO_IKEY;
if (env.DUO_SKEY) s.duoSecretKey = env.DUO_SKEY;
if (env.AUDIT_RETENTION_DAYS) s.auditRetentionDays = Number(env.AUDIT_RETENTION_DAYS);
if (env.AUDIT_STDOUT) s.auditStdout = env.AUDIT_STDOUT === 'true' || env.AUDIT_STDOUT === '1';

// tls: serve HTTPS directly. Defaults to on when protocol is https; set false when a proxy terminates TLS.
if (s.tls === null || s.tls === undefined) s.tls = s.protocol === 'https';
if (s.tls && s.protocol !== 'https') throw new Error('tls requires protocol "https"');
for (const k of ['tlsCertFile', 'tlsKeyFile']) if (s[k]) s[k] = path.resolve(root, s[k]);
s.port = Number(s.port);
if (!Number.isInteger(s.port) || s.port < 0 || s.port > 65535) throw new Error(`Invalid port in ${file}`);
if (!['http', 'https'].includes(s.protocol)) throw new Error('protocol must be "http" or "https"');

if (!Number.isFinite(s.auditRetentionDays) || s.auditRetentionDays < 0) throw new Error('auditRetentionDays must be 0 or more');

// Public URL used in metadata/entity IDs. Omit the port when it is the protocol default
// (e.g. behind a TLS proxy on 443, set protocol https + port 443).
if (!s.baseUrl) {
  const isDefault = (s.protocol === 'http' && s.port === 80) || (s.protocol === 'https' && s.port === 443);
  s.baseUrl = `${s.protocol}://${s.hostname}${isDefault ? '' : `:${s.port}`}`;
}
s.baseUrl = s.baseUrl.replace(/\/+$/, '');
if (s.dbPath !== ':memory:') s.dbPath = path.resolve(root, s.dbPath);

// Duo break-glass: while this file exists, Duo is off whatever the console says (see README, "Duo break-glass"). It sits next to
// the database, so anyone who can edit the server's data directory can use it, and nobody can use it from the web console.
s.duoBypassFile = path.join(s.dbPath === ':memory:' ? path.join(root, 'data') : path.dirname(s.dbPath), 'duo-disabled');

module.exports = s;
