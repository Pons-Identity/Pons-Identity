const db = require('../db');
const { safeFetchText } = require('../safe-fetch');
const md = require('./metadata-source');

// Metadata Query Protocol (MDQ) sources: instead of downloading every entity, ask the federation's query service for the one
// that is needed, verify its signature against the source's pinned certificate, and cache the answer. Answers are used until
// their cache lifetime ends, then asked for again; if the service is unreachable by then, the last copy keeps being used
// until the entity's own validUntil (stale-if-error), so an outage does not stop sign-in.

const MAX_ENTITY_ID = 1024;
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_MS = 5 * 60 * 1000; // an entity the service does not know is not asked for again for a while
const FAILURE_MS = 30 * 1000; // nor is the service hammered while it is failing
const MAX_LOOKUPS_PER_MINUTE = 60; // entity IDs come from sign-in requests, which anyone can send
const KEEP_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;

const negative = new Map();
const inflight = new Map();
let recent = [];

/** Forget in-memory state (for tests). */
function reset() {
  negative.clear();
  inflight.clear();
  recent = [];
}

/** An ISO 8601 duration such as PT6H or P1DT12H, in milliseconds; null when absent or unusable. */
function durationMs(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso || '');
  if (!m || !iso || iso === 'P' || iso.endsWith('T')) return null;
  return (((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 60 + Number(m[4] || 0)) * 1000;
}

const entityUrl = (src, entityId) => `${src.url}/entities/${encodeURIComponent(entityId)}`;
const validEntityId = (id) => typeof id === 'string' && id.length <= MAX_ENTITY_ID && /^[a-z][a-z0-9+.-]*:\S+$/i.test(id);

function allowLookup(t) {
  recent = recent.filter((x) => t - x < 60000);
  if (recent.length >= MAX_LOOKUPS_PER_MINUTE) return false;
  recent.push(t);
  return true;
}

const count = (sourceId) => db.get('SELECT COUNT(*) AS n FROM federation_entities WHERE source_id = ?', sourceId).n;

/**
 * Ask one MDQ source for one entity, verify it, and cache it. Throws on any failure, including `HTTP 404` when the
 * service does not know the entity. Returns the cached row.
 */
async function lookup(src, entityId, { fetchText = safeFetchText, now = new Date() } = {}) {
  const res = await fetchText(entityUrl(src, entityId), { timeoutMs: 15000, maxBytes: MAX_BYTES, headers: { Accept: 'application/samlmetadata+xml' } });
  const parsed = md.parseAggregate(res.text, src.signing_cert_pem, now);
  // Whatever the service sent must be exactly the entity that was asked for, never a different or additional one.
  const e = parsed.entities.length === 1 && parsed.entities[0].entityId === entityId ? parsed.entities[0] : null;
  if (!e) throw new Error('The service answered with a different entity than the one asked for.');

  const t = now.getTime();
  const ttl = Math.min(Math.max(durationMs(parsed.cacheDuration) ?? DEFAULT_TTL_MS, MIN_TTL_MS), MAX_TTL_MS);
  const expires = new Date(Math.min(t + ttl, Date.parse(parsed.validUntil))).toISOString();
  db.tx(() => {
    db.run('DELETE FROM federation_entities WHERE source_id = ? AND entity_id = ?', src.id, entityId);
    db.run(
      `INSERT INTO federation_entities (source_id, entity_id, is_idp, is_sp, display_name, valid_until, parsed, xml, fetched_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      src.id, entityId, e.isIdp ? 1 : 0, e.isSp ? 1 : 0, e.displayName, new Date(e.validUntil || parsed.validUntil).toISOString(),
      JSON.stringify(e.parsed), e.xml, now.toISOString(), expires);
    db.run("UPDATE federation_sources SET last_checked_at = ?, last_success_at = ?, last_error = '', entity_count = ? WHERE id = ?",
      now.toISOString(), now.toISOString(), count(src.id), src.id);
  });
  return md.findEntity(entityId);
}

/**
 * Make sure a usable copy of `entityId` is on hand if any enabled MDQ source can supply one. Safe to call for any string:
 * implausible IDs are ignored, repeated misses and failures are remembered, concurrent calls share one lookup, and the
 * number of lookups per minute is capped. Resolves to the entity row, or null; callers then use the synchronous lookups.
 */
async function ensureEntity(entityId, { fetchText, now = new Date() } = {}) {
  if (!validEntityId(entityId)) return null;
  const t = now.getTime();
  const have = md.findEntity(entityId);
  if (have && (!have.expires_at || Date.parse(have.expires_at) > t)) return have;

  const sources = db.all("SELECT * FROM federation_sources WHERE enabled = 1 AND kind = 'mdq' ORDER BY id");
  if (!sources.length || (negative.get(entityId) || 0) > t) return have;
  if (inflight.has(entityId)) return inflight.get(entityId);
  if (!allowLookup(t)) return have;

  const job = (async () => {
    let failed = false;
    for (const src of sources) {
      try {
        return await lookup(src, entityId, { fetchText, now });
      } catch (e) {
        if (/HTTP 404/.test(e.message)) continue;
        failed = true;
        db.run('UPDATE federation_sources SET last_checked_at = ?, last_error = ? WHERE id = ?', now.toISOString(), `${entityId}: ${e.message}`.slice(0, 500), src.id);
      }
    }
    if (negative.size > 1000) for (const [k, until] of negative) if (until <= t) negative.delete(k);
    negative.set(entityId, t + (failed ? FAILURE_MS : UNKNOWN_MS));
    return have; // stale-if-error: an expired cache entry that is still within its validUntil
  })().finally(() => inflight.delete(entityId));
  inflight.set(entityId, job);
  return job;
}

/** For the console's "test lookup": ask one source now, ignoring and replacing the cache. Throws with the reason. */
async function lookupNow(sourceId, entityId, options) {
  const src = md.get(sourceId);
  if (!src || src.kind !== 'mdq') throw new Error('That source is not an MDQ service.');
  if (!validEntityId(entityId)) throw new Error('Enter an entity ID, for example https://idp.example.net/idp.');
  try {
    return await lookup(src, entityId, options);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) throw new Error('The service does not know that entity.');
    db.run('UPDATE federation_sources SET last_checked_at = ?, last_error = ? WHERE id = ?', new Date().toISOString(), `${entityId}: ${e.message}`.slice(0, 500), sourceId);
    throw e;
  }
}

/** Drop cached lookups that have expired for good or have not been fetched in a month. */
function pruneCache(now = new Date()) {
  const cutoff = new Date(now.getTime() - KEEP_UNUSED_MS).toISOString();
  db.tx(() => {
    for (const s of db.all("SELECT id FROM federation_sources WHERE kind = 'mdq'")) {
      db.run("DELETE FROM federation_entities WHERE source_id = ? AND ((valid_until != '' AND valid_until < ?) OR (fetched_at != '' AND fetched_at < ?))", s.id, now.toISOString(), cutoff);
      db.run('UPDATE federation_sources SET entity_count = ? WHERE id = ?', count(s.id), s.id);
    }
  });
}

module.exports = { ensureEntity, lookupNow, pruneCache, durationMs, entityUrl, reset };
