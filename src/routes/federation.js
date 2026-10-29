const express = require('express');
const auditLog = require('../audit');
const db = require('../db');
const attrs = require('../attributes');
const appSettings = require('../app-settings');
const metadata = require('../federation/metadata-source');
const idp = require('../federation/idp');
const fedSp = require('../federation/sp');
const identities = require('../federation/identities');
const keyring = require('../federation/keyring');
const health = require('../federation/health');
const mdq = require('../federation/mdq');
const { CATALOG, CATEGORIES, releaseFor } = require('../federation/release-policy');
const { buildAttributes } = require('../saml/response');
const { certInfo, normalizeCertificate } = require('../saml/encrypt');
const { SIGNATURE_ALGORITHMS, ENCRYPTION_ALGORITHMS, KEY_TRANSPORT_ALGORITHMS } = require('../config');

// Console routes for federation metadata, mounted under /api/admin/federation (after requireAdmin).

// Certificate details for the active key set and any staged or retiring one; private keys never leave the server.
const pairView = (k) => ({ signing: certInfo(k.signing.certPem), encryption: certInfo(k.encryption.certPem) });
const keysView = (keys) => ({ ...pairView(keys), next: keys.next && pairView(keys.next), previous: keys.previous && pairView(keys.previous) });

const friendlyName = (name) => (Object.values(CATALOG).find((a) => a.name === name || a.aliases.includes(name)) || {}).friendly || '';

module.exports = function federationRoutes(need) {
  const router = express.Router();
  const fail = (res, errors) => res.status(400).json({ errors: [].concat(errors) });
  const load = (req, res, next) => {
    req.source = metadata.get(Number(req.params.id));
    return req.source ? next() : res.status(404).json({ error: 'No such metadata source.' });
  };

  router.get('/sources', need('federation.view'), (req, res) => res.json({
    sources: metadata.list(),
    defaults: {
      incommonUrl: 'https://md.incommon.org/InCommon/InCommon-metadata.xml',
      incommonIdpOnlyUrl: 'https://md.incommon.org/InCommon/InCommon-metadata-idp-only.xml',
      incommonMdqUrl: 'https://mdq.incommon.org',
      refreshHours: 6,
    },
  }));

  router.post('/sources', need('federation.manage'), (req, res) => {
    const { data, errors } = metadata.parseSourceForm(req.body);
    if (errors.length) return fail(res, errors);
    const id = Number(db.run(
      'INSERT INTO federation_sources (name, kind, roles, url, signing_cert_pem, enabled, refresh_hours) VALUES (?,?,?,?,?,?,?)',
      data.name, data.kind, data.roles, data.url, data.signing_cert_pem, data.enabled, data.refresh_hours).lastInsertRowid);
    auditLog.admin('federation.source.create', { actor: auditLog.who(req.user), target: { type: 'federation_source', id: id, name: data.name }, detail: { kind: data.kind, url: data.url } });
    res.status(201).json(metadata.sourceView(metadata.get(id)));
  });

  router.put('/sources/:id', need('federation.manage'), load, (req, res) => {
    const { data, errors } = metadata.parseSourceForm(req.body, req.source);
    if (errors.length) return fail(res, errors);
    // A new URL or certificate invalidates the cache validator, so the next refresh downloads in full.
    const changed = data.url !== req.source.url || data.signing_cert_pem !== req.source.signing_cert_pem || data.kind !== req.source.kind;
    db.tx(() => {
      db.run('UPDATE federation_sources SET name = ?, kind = ?, roles = ?, url = ?, signing_cert_pem = ?, enabled = ?, refresh_hours = ?, last_etag = ? WHERE id = ?',
        data.name, data.kind, data.roles, data.url, data.signing_cert_pem, data.enabled, data.refresh_hours, changed ? '' : req.source.last_etag, req.source.id);
      // Entities cached under the old address or certificate were verified against something else.
      if (changed && req.source.kind === 'mdq') db.run('DELETE FROM federation_entities WHERE source_id = ?', req.source.id);
    });
    auditLog.admin('federation.source.update', { actor: auditLog.who(req.user), target: { type: 'federation_source', id: req.source.id, name: data.name }, detail: { enabled: Boolean(data.enabled), url: data.url, endpointOrCertChanged: changed } });
    res.json(metadata.sourceView(metadata.get(req.source.id)));
  });

  // Ask an MDQ service for one entity right now: proves the URL and pinned certificate work without waiting for real traffic.
  router.post('/sources/:id/lookup', need('federation.manage'), load, async (req, res) => {
    try {
      const e = await mdq.lookupNow(req.source.id, String(req.body.entityId || '').trim());
      res.json({ entityId: e.entity_id, name: e.display_name, isIdp: Boolean(e.is_idp), isSp: Boolean(e.is_sp), source: metadata.sourceView(metadata.get(req.source.id)) });
    } catch (e) {
      res.status(502).json({ errors: [e.message], source: metadata.sourceView(metadata.get(req.source.id)) });
    }
  });

  router.delete('/sources/:id', need('federation.manage'), load, (req, res) => {
    db.run('DELETE FROM federation_sources WHERE id = ?', req.source.id);
    auditLog.admin('federation.source.delete', { actor: auditLog.who(req.user), target: { type: 'federation_source', id: req.source.id, name: req.source.name } });
    res.status(204).end();
  });

  router.post('/sources/:id/refresh', need('federation.manage'), load, async (req, res) => {
    auditLog.admin('federation.source.refresh', { actor: auditLog.who(req.user), target: { type: 'federation_source', id: req.source.id, name: req.source.name }, detail: { manual: true } });
    try {
      res.json({ ...(await metadata.refreshSource(req.source.id)), source: metadata.sourceView(metadata.get(req.source.id)) });
    } catch (e) {
      res.status(502).json({ errors: [e.message], source: metadata.sourceView(metadata.get(req.source.id)) });
    }
  });

  router.get('/health', need('federation.view'), (req, res) => res.json({ alerts: health.alerts() }));

  router.get('/entities', need('federation.view'), (req, res) => res.json(metadata.searchEntities({
    q: String(req.query.q || ''), role: String(req.query.role || ''), sourceId: Number(req.query.source) || 0,
    limit: req.query.limit, offset: req.query.offset,
  })));

  // Entity IDs are URLs, so the one to show is passed as a query parameter.
  router.get('/entity', need('federation.view'), (req, res) => {
    const e = metadata.findEntity(String(req.query.entityId || ''));
    if (!e) return res.status(404).json({ error: 'No such entity.' });
    // Fingerprints let an administrator compare a key with what the institution published elsewhere.
    const withInfo = (role) => role && { ...role, keys: role.keys.map((k) => {
      try {
        return { use: k.use, ...certInfo(normalizeCertificate(k.certificate)) };
      } catch {
        return { use: k.use, subject: 'Unreadable certificate', notAfter: '', sha256: '' };
      }
    }) };
    res.json({
      entity_id: e.entity_id, display_name: e.display_name, valid_until: e.valid_until,
      parsed: { ...e.parsed, idp: withInfo(e.parsed.idp), sp: withInfo(e.parsed.sp) },
    });
  });

  /* ----------------------------- Federation identity ----------------------------- */

  const idpView = () => {
    const { cfg, entityId, urls } = idp.identity();
    const keys = appSettings.federationKeys();
    const labels = (o) => Object.entries(o).filter(([k]) => k !== 'sha1').map(([value, v]) => ({ value, label: v.label }));
    return {
      config: cfg,
      entityId,
      defaultEntityId: idp.defaultEntityId(),
      urls: { ...urls, signedMetadata: `${urls.metadata}?signed=true` },
      keys: keys && keysView(keys),
      categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label, uri: c.uri, requestedOnly: Boolean(c.requested) })),
      affiliations: appSettings.AFFILIATIONS,
      eppnSources: appSettings.EPPN_SOURCES,
      algorithms: { signature: labels(SIGNATURE_ALGORITHMS), encryption: labels(ENCRYPTION_ALGORITHMS), keyTransport: labels(KEY_TRANSPORT_ALGORITHMS) },
    };
  };

  router.get('/idp', need('federation.view'), (req, res) => res.json(idpView()));

  router.put('/idp', need('federation.manage'), (req, res) => {
    const { data, errors } = appSettings.parseFederationIdp(req.body);
    if (errors.length) return fail(res, errors);
    appSettings.saveFederationIdp(data);
    auditLog.admin('federation.idp.settings', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'federation idp' } });
    idp.ensureKeys();
    res.json(idpView());
  });

  // What a user would be sent if they signed in to a federation SP, using the live policy. Works before the identity is enabled.
  router.get('/idp/preview', need('federation.manage'), async (req, res) => {
    if (!req.perms.has('users.view')) return res.status(403).json({ error: 'You do not have permission to do that.' });
    const user = db.get('SELECT * FROM users WHERE id = ?', Number(req.query.userId) || 0);
    if (!user) return fail(res, 'Choose a user to preview.');
    const entityId = String(req.query.entityId || '');
    await mdq.ensureEntity(entityId);
    const sp = idp.forEntity(entityId, { preview: true });
    if (!sp) return fail(res, 'That entity is not a service provider in the imported metadata, or it has no HTTP-POST assertion consumer service.');
    const ctx = { groups: attrs.userGroups(user.id), custom: attrs.userCustom(user.id), sp };
    const via = new Map(releaseFor(metadata.findEntity(entityId).parsed, appSettings.federationIdp()).reasons.map((r) => [r.name, r.via]));
    res.json({
      entityId,
      name: sp.name,
      registered: !sp.synthetic,
      nameIdFormat: sp.nameid_format,
      encrypted: Boolean(sp.encrypt_assertion && sp.encryption_cert_pem),
      attributes: buildAttributes(sp, user, ctx, []).map((a) => ({ ...a, friendly: friendlyName(a.name), via: via.get(a.name) || (sp.synthetic ? '' : 'Registered service provider') })),
    });
  });

  /* ------------------- Signing in people from other institutions ------------------- */

  const spView = () => {
    const { cfg, entityId, urls } = fedSp.identity();
    const keys = appSettings.federationSpKeys();
    return {
      config: cfg,
      entityId,
      defaultEntityId: urls.metadata,
      urls: { ...urls, signedMetadata: `${urls.metadata}?signed=true` },
      keys: keys && keysView(keys),
      provisioning: appSettings.PROVISIONING,
      pending: identities.list('pending').length,
    };
  };

  router.get('/sp', need('federation.view'), (req, res) => res.json(spView()));

  router.put('/sp', need('federation.manage'), (req, res) => {
    const { data, errors } = appSettings.parseFederationSp(req.body, appSettings.federationIdp());
    if (errors.length) return fail(res, errors);
    appSettings.saveFederationSp(data);
    auditLog.admin('federation.sp.settings', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'federation sp' }, detail: { provisioning: data.provisioning, enabled: Boolean(data.enabled) } });
    fedSp.ensureKeys();
    res.json(spView());
  });

  router.get('/identities', need('federation.view'), (req, res) => res.json({ identities: identities.list(String(req.query.status || '')) }));

  // Accepting someone creates an account or links them to an existing one, so it also needs the right to manage users.
  const needUsers = (req, res, next) => (req.perms.has('users.manage') ? next() : res.status(403).json({ error: 'You do not have permission to do that.' }));
  const run = (req, res, action, fn) => {
    try {
      const row = db.get('SELECT id, idp_entity_id, display_name FROM federated_identities WHERE id = ?', Number(req.params.id));
      fn();
      auditLog.admin(action, { actor: auditLog.who(req.user), target: { type: 'federated_identity', id: req.params.id, name: row ? row.display_name || row.idp_entity_id : '' },
        detail: { idp: row && row.idp_entity_id, ...(req.body && req.body.status ? { status: req.body.status } : {}), ...(req.body && req.body.user_id ? { linkedUserId: Number(req.body.user_id) } : {}) } });
      res.json({ identities: identities.list() });
    } catch (e) {
      fail(res, e.message);
    }
  };
  router.post('/identities/:id/approve', need('federation.manage'), needUsers,
    (req, res) => run(req, res, 'federation.identity.approve', () => identities.approve(Number(req.params.id), { userId: Number(req.body.user_id) || 0 })));
  router.post('/identities/:id/status', need('federation.manage'), (req, res) => run(req, res, 'federation.identity.status', () => identities.setStatus(Number(req.params.id), String(req.body.status || ''))));
  router.delete('/identities/:id', need('federation.manage'), (req, res) => run(req, res, 'federation.identity.delete', () => identities.remove(Number(req.params.id))));

  /* ------------------------------- Key rollover ------------------------------- */

  // stage: publish a new key. activate: start using it (the old one stays published). retire: drop the old one.
  const KEYSETS = {
    idp: { ensure: () => idp.ensureKeys(), save: (k) => appSettings.saveFederationKeys(k), label: idp.KEY_LABEL, view: idpView },
    sp: { ensure: () => fedSp.ensureKeys(), save: (k) => appSettings.saveFederationSpKeys(k), label: fedSp.KEY_LABEL, view: spView },
  };
  router.post('/:kind(idp|sp)/keys/:action', need('federation.manage'), (req, res) => {
    const set = KEYSETS[req.params.kind];
    const action = keyring.ACTIONS[req.params.action];
    if (!action) return res.status(404).json({ error: 'No such key action.' });
    try {
      set.save(action(set.ensure(), set.label));
    } catch (e) {
      return fail(res, e.message);
    }
    auditLog.admin(`federation.key.${req.params.action}`, { actor: auditLog.who(req.user), target: { type: 'federation_keys', name: req.params.kind } });
    res.json(set.view());
  });

  return router;
};
