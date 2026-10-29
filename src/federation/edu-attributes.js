const appSettings = require('../app-settings');
const { persistentId } = require('./pairwise-id');

// eduPerson / SCHAC / SAML subject attributes computed from the user, the federation settings and the SP being served.
// `ctx.sp` is the service provider the assertion is for; values that depend on it are empty without one.

const SCOPED_IMPLIES_MEMBER = new Set(['faculty', 'staff', 'student', 'employee']);

function affiliations(ctx) {
  const cfg = appSettings.federationIdp();
  const names = new Set((ctx.groups || []).map((g) => g.name.toLowerCase()));
  const out = new Set(cfg.affiliationGroups.filter((r) => names.has(r.group.toLowerCase())).map((r) => r.affiliation));
  if (!out.size && cfg.defaultAffiliation) out.add(cfg.defaultAffiliation);
  if ([...out].some((a) => SCOPED_IMPLIES_MEMBER.has(a))) out.add('member');
  return [...out];
}

function principalName(user, cfg) {
  const raw = String(user[cfg.eppnSource] || '').trim();
  if (!raw || !cfg.scope) return [];
  // Whatever domain the source value carries, the released value is scoped to the federation scope.
  const local = raw.includes('@') ? raw.slice(0, raw.lastIndexOf('@')) : raw;
  return [`${local}@${cfg.scope}`];
}

const KEYS = new Set([
  'eduperson_principal_name', 'eduperson_affiliation', 'eduperson_scoped_affiliation', 'eduperson_targeted_id',
  'persistent_id', 'pairwise_id', 'subject_id', 'schac_home_organization',
]);

/** Returns the values for a federation attribute key, or null when `key` is not one of them. */
function resolveEdu(user, key, ctx) {
  if (!KEYS.has(key)) return null;
  const cfg = appSettings.federationIdp();
  const spEntityId = ctx.sp && ctx.sp.sp_entity_id;
  switch (key) {
    case 'schac_home_organization': return cfg.scope ? [cfg.scope] : [];
    case 'eduperson_principal_name': return principalName(user, cfg);
    case 'eduperson_affiliation': return affiliations(ctx);
    case 'eduperson_scoped_affiliation': return cfg.scope ? affiliations(ctx).map((a) => `${a}@${cfg.scope}`) : [];
    case 'persistent_id':
    case 'eduperson_targeted_id': return spEntityId ? [persistentId(user.id, spEntityId)] : [];
    case 'pairwise_id': return spEntityId && cfg.scope ? [`${persistentId(user.id, spEntityId)}@${cfg.scope}`] : [];
    case 'subject_id': return cfg.scope && user.guid ? [`${String(user.guid).toLowerCase()}@${cfg.scope}`] : [];
    default: return [];
  }
}

module.exports = { resolveEdu, KEYS };
