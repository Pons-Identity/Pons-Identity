const { SignedXml } = require('xml-crypto');
const db = require('../db');
const { parseXml } = require('../saml/xml');
const { normalizeCertificate, certInfo } = require('../saml/encrypt');
const { safeFetchText } = require('../safe-fetch');
const { parseEntity, kids } = require('./entity-parser');

// A signed aggregate is large (tens of MB), so its cap is far above the default fetch limit.
const MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;
// A refresh that would drop more than this share of the entities we already hold is treated as a damaged download.
const MAX_SHRINK = 0.5;

const sourceView = (s) => s && {
  ...s, enabled: Boolean(s.enabled), signing_cert_pem: undefined, has_cert: Boolean(s.signing_cert_pem),
  signing_cert: certInfo(s.signing_cert_pem),
};

function list() {
  return db.all('SELECT * FROM federation_sources ORDER BY name').map(sourceView);
}
const get = (id) => db.get('SELECT * FROM federation_sources WHERE id = ?', id);

/** Validate the admin form. Returns { data, errors }; the certificate may be omitted on update to keep the pinned one. */
function parseSourceForm(body, existing) {
  const errors = [];
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const kind = str(body.kind) || (existing ? existing.kind : 'aggregate');
  const data = {
    name: str(body.name),
    kind,
    // An MDQ service is addressed by its base URL; a trailing slash or /entities path is not part of it.
    url: kind === 'mdq' ? str(body.url).replace(/\/+$/, '').replace(/\/entities$/i, '') : str(body.url),
    roles: str(body.roles) || (existing ? existing.roles : 'all'),
    signing_cert_pem: str(body.signing_cert_pem) || (existing ? existing.signing_cert_pem : ''),
    enabled: body.enabled === undefined ? 1 : (body.enabled ? 1 : 0),
    refresh_hours: Number(body.refresh_hours ?? (existing ? existing.refresh_hours : 6)),
  };
  if (!data.name) errors.push('Name is required.');
  if (!['aggregate', 'mdq'].includes(data.kind)) errors.push('Choose a metadata file or an MDQ service.');
  if (data.kind === 'mdq') data.roles = 'all';
  if (!['all', 'idp', 'sp'].includes(data.roles)) errors.push('Choose which entities to keep.');
  if (!/^https:\/\//i.test(data.url)) errors.push(data.kind === 'mdq' ? 'MDQ service URL must be https.' : 'Metadata URL must be https.');
  if (!Number.isInteger(data.refresh_hours) || data.refresh_hours < 1 || data.refresh_hours > 168) {
    errors.push('Refresh interval must be between 1 and 168 hours.');
  }
  if (!data.signing_cert_pem) {
    errors.push('A signing certificate is required: metadata is only trusted when signed by a pinned certificate.');
  } else {
    try {
      data.signing_cert_pem = normalizeCertificate(data.signing_cert_pem);
    } catch (e) {
      errors.push(`Signing certificate: ${e.message}`);
    }
  }
  return { data, errors };
}

/**
 * Check that the document root carries one enveloped signature, made by `certPem`, over the root element itself.
 * Anything signed only in part (e.g. a signature over a child) would let unsigned entities ride along, so is refused.
 */
function verifyAggregateSignature(xml, root, certPem) {
  const sigs = kids(root, 'Signature');
  if (sigs.length !== 1) throw new Error('Metadata is not signed.');
  const sig = new SignedXml({ publicCert: certPem });
  sig.loadSignature(sigs[0]);
  const refs = sig.getReferences();
  const id = root.getAttribute('ID');
  if (!id || refs.length !== 1 || refs[0].uri !== `#${id}`) throw new Error('The metadata signature does not cover the whole document.');
  if (!sig.checkSignature(xml)) throw new Error('Metadata signature is invalid.');
}

/**
 * Verify and parse a signed aggregate. Returns { validUntil, entities }.
 * Throws if it is unsigned, signed by another key, expired, or empty.
 */
function parseAggregate(xml, certPem, now = new Date(), { roles = 'all' } = {}) {
  const root = parseXml(xml).documentElement;
  if (!['EntitiesDescriptor', 'EntityDescriptor'].includes(root.localName)) throw new Error('Not SAML metadata.');
  verifyAggregateSignature(xml, root, certPem);
  const validUntil = root.getAttribute('validUntil');
  if (!validUntil) throw new Error('Metadata has no validUntil, so its freshness cannot be established.');
  if (!(new Date(validUntil) > now)) throw new Error(`Metadata expired on ${validUntil}.`);

  const found = [];
  const walk = (el) => {
    for (const child of kids(el, 'EntityDescriptor')) found.push(child);
    for (const child of kids(el, 'EntitiesDescriptor')) walk(child);
  };
  if (root.localName === 'EntityDescriptor') found.push(root); else walk(root);

  const entities = new Map();
  for (const el of found) {
    let e;
    try {
      e = parseEntity(el);
    } catch {
      continue; // one malformed entity must not poison the whole aggregate
    }
    if (e.validUntil && !(new Date(e.validUntil) > now)) continue;
    if ((roles === 'idp' && !e.isIdp) || (roles === 'sp' && !e.isSp)) continue;
    entities.set(e.entityId, e);
  }
  if (!entities.size) throw new Error('Metadata contains no usable entities.');
  return { validUntil, cacheDuration: root.getAttribute('cacheDuration') || '', entities: [...entities.values()] };
}

const nowIso = () => new Date().toISOString();

/**
 * Download, verify and swap in one source's entities. The old data stays in place unless every check passes.
 * `fetchText` is injectable for tests. Returns { notModified } or { count, validUntil }; throws on failure
 * after recording the error on the source.
 */
async function refreshSource(id, { fetchText = safeFetchText, now = new Date() } = {}) {
  const src = get(id);
  if (!src) throw new Error('No such metadata source.');
  if (src.kind === 'mdq') throw new Error('This source is queried on demand; there is nothing to refresh.');
  const stamp = (fields) => db.run(
    `UPDATE federation_sources SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(fields), id);
  try {
    const headers = src.last_etag ? { 'If-None-Match': src.last_etag } : undefined;
    const res = await fetchText(src.url, { timeoutMs: 120000, maxBytes: MAX_AGGREGATE_BYTES, headers });
    if (res.status === 304) {
      stamp({ last_checked_at: nowIso(), last_error: '' });
      return { notModified: true };
    }
    const { validUntil, entities } = parseAggregate(res.text, src.signing_cert_pem, now, { roles: src.roles });
    if (src.entity_count >= 20 && entities.length < src.entity_count * MAX_SHRINK) {
      throw new Error(`Refusing a refresh with ${entities.length} entities when ${src.entity_count} are held; the download looks truncated.`);
    }
    db.tx(() => {
      db.run('DELETE FROM federation_entities WHERE source_id = ?', id);
      for (const e of entities) {
        db.run(
          `INSERT INTO federation_entities (source_id, entity_id, is_idp, is_sp, display_name, valid_until, parsed, xml)
           VALUES (?,?,?,?,?,?,?,?)`,
          id, e.entityId, e.isIdp ? 1 : 0, e.isSp ? 1 : 0, e.displayName, e.validUntil ? new Date(e.validUntil).toISOString() : '',
          JSON.stringify(e.parsed), e.xml);
      }
      stamp({
        last_etag: (res.headers && res.headers.get && res.headers.get('etag')) || '',
        last_checked_at: nowIso(), last_success_at: nowIso(), last_error: '', entity_count: entities.length, valid_until: new Date(validUntil).toISOString(),
      });
    });
    return { count: entities.length, validUntil };
  } catch (e) {
    stamp({ last_checked_at: nowIso(), last_error: e.message.slice(0, 500) });
    throw e;
  }
}

/** Enabled sources whose last check is older than their refresh interval. */
function dueSources(now = Date.now()) {
  return db.all("SELECT * FROM federation_sources WHERE enabled = 1 AND kind = 'aggregate'").filter((s) => {
    const last = s.last_checked_at ? Date.parse(`${s.last_checked_at.replace(' ', 'T')}${/Z$/.test(s.last_checked_at) ? '' : 'Z'}`) : 0;
    return !(last > now - s.refresh_hours * 3600 * 1000);
  });
}

// Metadata past its validUntil is not trusted: a source that cannot be refreshed stops serving entities rather than
// serving old keys and endpoints indefinitely (the same fail-closed rule Shibboleth applies). Timestamps are stored as UTC ISO.
const USABLE = "(e.valid_until = '' OR e.valid_until > ?) AND (s.valid_until = '' OR s.valid_until > ?)";
const usableArgs = () => { const t = new Date().toISOString(); return [t, t]; };

/** Look up one usable imported entity. */
function findEntity(entityId) {
  const row = db.get(
    `SELECT e.* FROM federation_entities e JOIN federation_sources s ON s.id = e.source_id
     WHERE e.entity_id = ? AND ${USABLE} ORDER BY e.valid_until DESC LIMIT 1`, entityId, ...usableArgs());
  return row && { ...row, parsed: JSON.parse(row.parsed) };
}

/** Search usable imported entities without their XML. */
function searchEntities({ q = '', role = '', sourceId = 0, limit = 50, offset = 0, ids = null } = {}) {
  const where = [USABLE];
  const args = [...usableArgs()];
  if (q) {
    where.push("(e.entity_id LIKE ? ESCAPE '\\' OR e.display_name LIKE ? ESCAPE '\\')");
    const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like);
  }
  if (role === 'idp') where.push('e.is_idp = 1');
  if (role === 'sp') where.push('e.is_sp = 1');
  if (sourceId) { where.push('e.source_id = ?'); args.push(sourceId); }
  if (ids) {
    if (!ids.length) return { total: 0, entities: [] };
    where.push(`e.entity_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  const from = 'FROM federation_entities e JOIN federation_sources s ON s.id = e.source_id';
  const clause = `WHERE ${where.join(' AND ')}`;
  // An entity can come from more than one source (a bulk file and a cached lookup); list it once.
  const total = db.get(`SELECT COUNT(DISTINCT e.entity_id) AS n ${from} ${clause}`, ...args).n;
  const rows = db.all(
    `SELECT e.source_id, e.entity_id, e.is_idp, e.is_sp, e.display_name, e.valid_until ${from} ${clause}
     GROUP BY e.entity_id ORDER BY e.display_name COLLATE NOCASE LIMIT ? OFFSET ?`, ...args, Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0));
  return { total, entities: rows.map((r) => ({ ...r, is_idp: Boolean(r.is_idp), is_sp: Boolean(r.is_sp) })) };
}

module.exports = {
  list, get, parseSourceForm, parseAggregate, refreshSource, dueSources, findEntity, searchEntities, sourceView, verifyAggregateSignature,
};
