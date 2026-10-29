const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const db = require('./db');
const SqliteStore = require('./session-store');
const { baseUrl } = require('./config');
const { newGuid } = require('./guid');
const { hashPassword, generateKeyAndCert } = require('./crypto');
const settings = require('./settings');
const appSettings = require('./app-settings');
const auditLog = require('./audit');
const auditContext = require('./audit-context');
const auditForward = require('./audit-forward');
const security = require('./security-settings');

// Built React app (npm run build:web).
const webDist = path.join(__dirname, '..', 'web', 'dist');
const SPA_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
  + "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

// Serves the React shell for page navigations the server does not own (login screens, the admin console).
function spaShell(req, res, next) {
  if (!req.accepts('html') || req.path.startsWith('/api') || req.path.startsWith('/saml') || req.path.startsWith('/cas/') || req.path.startsWith('/oidc/') || req.path.startsWith('/oauth2/') || req.path.startsWith('/fed/') || req.path.startsWith('/directory/') || req.path.startsWith('/group-api/')) return next();
  const index = path.join(webDist, 'index.html');
  if (!fs.existsSync(index)) {
    return res.status(503).render('error', { title: 'Front-end not built', message: `Run "npm run build:web" and restart ${appSettings.productName()}.` });
  }
  res.set('Content-Security-Policy', SPA_CSP);
  res.sendFile(index);
}

function sessionSecret() {
  if (settings.sessionSecret) return settings.sessionSecret;
  let row = db.get("SELECT value FROM settings WHERE key = 'session_secret'");
  if (!row) {
    db.run("INSERT INTO settings (key, value) VALUES ('session_secret', ?)", crypto.randomBytes(32).toString('hex'));
    auditLog.system('session_secret.generate');
    row = db.get("SELECT value FROM settings WHERE key = 'session_secret'");
  }
  return row.value;
}

function seedAdmin() {
  if (db.get('SELECT 1 FROM users LIMIT 1')) return;
  const password = settings.adminPassword || crypto.randomBytes(9).toString('base64url');
  db.run(
    `INSERT INTO users (guid, username, password_hash, first_name, last_name, display_name, email, mfa_enabled)
     VALUES (?, 'admin', ?, 'Admin', 'User', 'Admin User', 'admin@example.com', 0)`,
    newGuid(), hashPassword(password));
  db.run(`INSERT INTO user_roles (user_id, role_id)
          SELECT u.id, r.id FROM users u, roles r WHERE u.username = 'admin' AND r.key = 'admin'`);
  auditLog.system('admin.seed', { target: { type: 'user', name: 'admin' }, detail: { source: settings.adminPassword ? 'configured' : 'generated' } });
  console.log('\n  Created initial administrator account:');
  console.log('    username: admin');
  console.log(`    password: ${password}\n`);
}

// Ends a session that has outlived the limits set under Settings > Sessions, checked on every request (so a change applies to
// sessions already open). `sessionHours` counts from the moment of sign-in whatever the person does; `idleMinutes`, when set,
// from the last request. The session is replaced by an empty one, so the person simply finds themselves signed out.
// lastSeen is written at most every 30 seconds, which is the finest the idle timeout can be measured (it is at least five minutes).
const SEEN_EVERY_MS = 30 * 1000;
function sessionLimits(req, res, next) {
  const s = req.session;
  if (!s || !s.userId || req.path.startsWith('/assets/')) return next();
  const { sessionHours, idleMinutes } = security.get();
  const t = Date.now();
  const started = Date.parse(s.authnInstant);
  const seen = Number(s.lastSeen) || t;
  const reason = Number.isFinite(started) && t - started > sessionHours * 3600 * 1000 ? 'session_length'
    : idleMinutes && t - seen > idleMinutes * 60 * 1000 ? 'idle' : null;
  if (reason) {
    const user = db.get('SELECT * FROM users WHERE id = ?', s.userId);
    auditLog.user('session.expired', { req, actor: user ? auditLog.who(user) : { type: 'anonymous', name: '' }, detail: { reason } });
    db.run('DELETE FROM sso_sessions WHERE sid = ?', req.sessionID);
    return req.session.regenerate((err) => next(err));
  }
  if (!s.lastSeen || t - s.lastSeen > SEEN_EVERY_MS) s.lastSeen = t;
  return next();
}

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // Forms send the token as _csrf; the JSON API sends it as X-CSRF-Token.
    const sent = Buffer.from(String(req.get('x-csrf-token') || (req.body && req.body._csrf) || ''));
    const want = Buffer.from(req.session.csrf);
    if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) {
      if (req.path.startsWith('/api')) {
        return res.status(403).json({ errors: ['Your session token is missing or stale. Reload the page and try again.'] });
      }
      return res.status(403).render('error', { title: 'Invalid form token', message: 'Your form expired. Go back, reload the page, and try again.' });
    }
  }
  next();
}

// Use the configured certificate/key, or create a self-signed one for the hostname on first start.
function loadTlsCredentials() {
  let certFile = settings.tlsCertFile;
  let keyFile = settings.tlsKeyFile;
  if (!certFile || !keyFile) {
    const dir = path.join(path.dirname(settings.dbPath), 'tls');
    certFile = path.join(dir, 'server.crt');
    keyFile = path.join(dir, 'server.key');
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      fs.mkdirSync(dir, { recursive: true });
      const names = [...new Set([settings.hostname, 'localhost', '127.0.0.1', '::1'])];
      const { keyPem, certPem } = generateKeyAndCert(settings.hostname, { altNames: names, days: 825 });
      fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
      fs.writeFileSync(certFile, certPem);
      auditLog.system('tls.generate', { detail: { names, certFile } });
      console.log(`  Generated self-signed TLS certificate for ${names.join(', ')}:\n    ${certFile}`);
      console.log('  Browsers will warn about it; supply tlsCertFile/tlsKeyFile for a trusted certificate.\n');
    }
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

function createApp() {
  const app = express();
  const secureCookies = baseUrl.startsWith('https://');
  if (settings.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  // Security headers on every response. HSTS is sent whenever the public address is https (BASE_URL), also when a proxy terminates TLS
  // in front of this server; browsers ignore it on a plain-http connection. The content security policy is not set here: the console
  // shell sets its own (SPA_CSP), and the server-rendered pages need inline script to post SAML messages to other sites.
  // Cross-origin resource policy stays open because the OIDC endpoints are called from other sites and the sign-in page's clone-detection
  // beacon is an image loaded from copies of it; the opener policy allows popups so a relying party can open sign-in in one.
  app.use(helmet({
    contentSecurityPolicy: false,
    strictTransportSecurity: secureCookies ? { maxAge: 15552000, includeSubDomains: false } : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }));
  app.set('views', path.join(__dirname, '..', 'views'));

  // Request id / client IP / user agent for the audit log; first so the bearer-token APIs below are covered too.
  app.use(auditContext.middleware);

  // SCIM provisioning from Grouper: bearer-token API with its own body parsing, no cookies or CSRF.
  app.use(require('./scim').BASE, require('./scim').router);

  // Read-only feed for Grouper's loader: bearer token, no cookies or CSRF.
  app.use(require('./grouper-feed').BASE, require('./grouper-feed').router);

  // REST API for external directories: per-directory bearer tokens, no cookies or CSRF.
  app.use(require('./directory-api').BASE, require('./directory-api').router);

  // REST API for managing groups and group folders: bearer tokens from Settings → Group API, no cookies or CSRF.
  app.use(require('./group-api').BASE, require('./group-api').router);

  // REST API for creating and managing users: bearer tokens from Settings → User API, no cookies or CSRF. Its docs are served beside it.
  app.use(require('./user-api').BASE, require('./user-api').router);

  // Webhooks that start an integration script: bearer token from the integration's page, no cookies or CSRF.
  app.use('/hooks/integrations', require('./routes/integrations').hook);

  // Twilio fetches these during a voice sign-in call: no session, no CSRF; the token in the path is the secret.
  app.use('/factors/voice', require('./routes/factors').voiceWebhook);
  // Replies from email and text providers. They post without a session, and each one is checked by its own signature (messaging/inbound.js).
  app.use('/messaging/inbound', require('./messaging/inbound'));
  // Status changes from an identity verification provider (Persona, or a REST service): checked again with the provider.
  app.use('/identity', require('./routes/identity'));

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(session({
    store: new SqliteStore(),
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    // A function, so the session length set in the console applies to every session created after it is changed.
    cookie: () => ({
      httpOnly: true,
      maxAge: security.get().sessionHours * 3600 * 1000,
      // SAML POST bindings are cross-site POSTs; over HTTPS allow the cookie on them.
      ...(secureCookies ? { secure: true, sameSite: 'none' } : {}),
    }),
  }));
  app.use(sessionLimits);

  // Branding for the server-rendered pages (sign-out, errors).
  app.use((req, res, next) => {
    res.locals.branding = appSettings.branding();
    next();
  });

  // SAML endpoints are protocol endpoints (cross-site POSTs from SPs) so they are exempt from CSRF tokens.
  app.use('/saml', require('./routes/saml'));
  // CAS, OpenID Connect and OAuth 2.0 are protocol endpoints too: clients post to them from other origins, so no CSRF tokens.
  app.use('/cas', require('./routes/cas'));
  app.use('/oidc', require('./routes/oidc').oidc);
  app.use('/oauth2', require('./routes/oidc').oauth2);
  app.use('/fed/idp', require('./routes/federation-idp'));
  app.use('/fed/sp', require('./routes/federation-sp'));

  app.use(csrf);
  app.use('/api/login-page', require('./routes/login-page'));
  app.use('/api', require('./routes/api'));
  app.use(require('./routes/auth'));
  app.use('/admin', require('./routes/admin'));

  app.use(express.static(webDist, { index: false }));
  app.get('*', spaShell);

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (req.path.startsWith('/api')) {
      // Malformed JSON bodies fail here, before the API router runs.
      if (err.type === 'entity.parse.failed') return res.status(400).json({ errors: ['Request body is not valid JSON.'] });
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
    console.error(err);
    res.status(500).render('error', { title: 'Server error', message: 'Something went wrong.' });
  });
  return app;
}

if (require.main === module) {
  auditForward.start(appSettings.auditForwardingSinks()); // before anything is recorded, so first-run events are forwarded too
  // A new database with nobody in it opens the setup wizard (setup.js). Installs that set ADMIN_PASSWORD, or SETUP_WIZARD=false,
  // are configured by their operator: the administrator is made here as before and no wizard is shown.
  const wizard = require('./setup');
  if (wizard.unattended()) seedAdmin();
  wizard.begin();
  new SqliteStore().prune();
  const app = createApp();
  auditLog.system('system.start', { detail: { baseUrl, tls: Boolean(settings.tls), node: process.version, forwarding: auditForward.status().map((x) => x.sink) } });
  if (appSettings.duo().bypassed) auditLog.system('settings.duo_bypass', { detail: { file: settings.duoBypassFile } });
  const pruneAudit = () => {
    const removed = auditLog.prune(settings.auditRetentionDays);
    require('./authlog').prune(settings.auditRetentionDays);
    if (removed) auditLog.system('audit.prune', { detail: { removed, retentionDays: settings.auditRetentionDays } });
  };
  pruneAudit();
  require('./geoip').load().catch((e) => console.error('GeoIP databases:', e.message));
  setInterval(pruneAudit, 24 * 3600 * 1000).unref();
  require('./federation/scheduler').start();
  require('./group-expiry').startExpiryJob();
  require('./guests').startExpiryJob();
  require('./group-attestation-reminders').startReminderJob();
  // Local groups made before include and exclude groups existed get them now.
  require('./group-include-exclude').ensureAll();
  require('./group-rules').startJob();
  require('./radius').apply();
  require('./user-scheduler').startJob();
  require('./provisioning').startJob();
  try {
    const made = require('./integrations/builtin').seed();
    if (made.length) console.log(`Created built-in integrations: ${made.join(', ')}`);
  } catch (e) { console.error('Built-in integrations:', e.message); }
  require('./integrations/triggers').startJob();
  try {
    const moved = require('./files/logs').migrateLegacy();
    if (moved) console.log(`Moved ${moved} saved log lines into the files module`);
    const stopped = require('./integrations').recoverRuns();
    if (stopped) console.log(`Marked ${stopped} integration runs that were going when the server stopped as errors`);
  } catch (e) { console.error('Integration logs and runs:', e.message); }
  require('./files/sftp-server').start();
  const server = settings.tls ? https.createServer(loadTlsCredentials(), app) : http.createServer(app);
  // Lets the upgrade tool (scripts/upgrade.js) see that the server is running before it changes the code and the database.
  const pidFile = path.join(path.dirname(settings.dbPath), 'server.pid');
  if (settings.dbPath !== ':memory:') try { fs.writeFileSync(pidFile, String(process.pid)); process.on('exit', () => { try { fs.unlinkSync(pidFile); } catch { /* already gone */ } }); } catch { /* read-only data directory */ }
  server.listen(settings.port, settings.bindAddress, () => {
    console.log(`${appSettings.productName()} listening on ${settings.tls ? 'https' : 'http'}://${settings.bindAddress}:${settings.port}`);
    console.log(`Public base URL (used in SAML metadata): ${baseUrl}`);
    if (appSettings.duo().bypassed) console.warn(`Duo is OFF: break-glass file ${settings.duoBypassFile} is present. Delete it to turn Duo back on.`);
  });
  // Record a clean stop and give log forwarding a moment to deliver it.
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      auditLog.system('system.stop', { detail: { signal } });
      // Directory connections held by running scripts are let go of before the process ends.
      await Promise.race([Promise.all([auditForward.flush(), require('./directory-sessions').closeAll()]), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
      process.exit(0);
    });
  }
  if (settings.tls && settings.httpRedirectPort) {
    http.createServer((req, res) => {
      res.writeHead(301, { Location: baseUrl + req.url });
      res.end();
    }).listen(settings.httpRedirectPort, settings.bindAddress, () => {
      console.log(`Redirecting http://${settings.bindAddress}:${settings.httpRedirectPort} to ${baseUrl}`);
    });
  }
}

module.exports = { createApp, seedAdmin, sessionLimits };
