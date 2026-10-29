const crypto = require('crypto');
const db = require('./db');
const { effectiveGroupsOf } = require('./group-membership');
const { generateKeyAndCert } = require('./crypto');
const { NAMEID_FORMATS, SIGNATURE_ALGORITHMS, ENCRYPTION_ALGORITHMS, KEY_TRANSPORT_ALGORITHMS, spUrls } = require('./config');
const { normalizeCertificate, certInfo } = require('./saml/encrypt');
const { parseRules } = require('./transform');
const { rolesOf } = require('./group-pipeline');

const ACCESS_MODES = ['none', 'groups', 'all'];

const toArr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

function getSp(id) {
  const sp = db.get('SELECT * FROM service_providers WHERE id = ?', id);
  if (!sp) return null;
  sp.acs_urls = JSON.parse(sp.acs_urls);
  sp.transform_temp_attrs = JSON.parse(sp.transform_temp_attrs || '[]');
  sp.maps = db.all('SELECT idp_attribute, saml_name FROM sp_attribute_map WHERE sp_id = ? ORDER BY id', id);
  sp.statics = db.all('SELECT name, value FROM sp_static_attributes WHERE sp_id = ? ORDER BY id', id);
  sp.roles = db.all(
    `SELECT r.saml_name, r.group_id, r.role_value, g.name AS group_name
     FROM sp_role_attributes r JOIN groups g ON g.id = r.group_id WHERE r.sp_id = ? ORDER BY r.id`, id);
  sp.access_groups = db.all(
    `SELECT g.id, g.name FROM sp_access_groups a JOIN groups g ON g.id = a.group_id WHERE a.sp_id = ? ORDER BY g.name`, id)
    .map((g) => g.id);
  sp.urls = spUrls(id);
  sp.encryption_cert = certInfo(sp.encryption_cert_pem);
  sp.signing_cert = certInfo(sp.signing_cert_pem);
  return sp;
}

function listSps() {
  return db.all('SELECT id, name, sp_entity_id, nameid_format, created_at FROM service_providers ORDER BY name');
}

function blankSp() {
  return {
    name: '', description: '', metadata_mode: 'none', metadata_url: '', sp_entity_id: '', acs_urls: [''], slo_url: '', login_url: '', default_relay_state: '',
    nameid_format: 'emailAddress', nameid_source: 'email', signature_algorithm: 'sha256',
    sign_response: 1, sign_assertion: 1, groups_attribute: '', grouper_groups: 0,
    signing_cert_pem: '', encrypt_assertion: 0, encryption_cert_pem: '', encryption_algorithm: 'aes256-cbc',
    key_transport_algorithm: 'rsa-oaep-mgf1p', transform_enabled: 1, transform_rules: '',
    transform_nameid_attr: '', transform_temp_attrs: [],
    access_mode: 'none', access_groups: [],
    maps: [], statics: [], roles: [],
  };
}

// Parse + validate the admin form. Returns { data, errors }.
// A draft is created as soon as the New page opens, so it may leave out the name and ACS URL; other checks still apply.
function parseForm(body, { draft = false } = {}) {
  const errors = [];
  const data = {
    name: str(body.name),
    description: str(body.description),
    metadata_mode: str(body.metadata_mode) || 'none',
    metadata_url: str(body.metadata_url),
    sp_entity_id: str(body.sp_entity_id),
    acs_urls: toArr(body.acs_url).map(str).filter(Boolean),
    slo_url: str(body.slo_url),
    login_url: str(body.login_url),
    default_relay_state: str(body.default_relay_state),
    nameid_format: str(body.nameid_format),
    nameid_source: str(body.nameid_source),
    signature_algorithm: str(body.signature_algorithm) || 'sha256',
    sign_response: body.sign_response ? 1 : 0,
    sign_assertion: body.sign_assertion ? 1 : 0,
    groups_attribute: str(body.groups_attribute),
    grouper_groups: body.grouper_groups ? 1 : 0,
    encrypt_assertion: body.encrypt_assertion ? 1 : 0,
    encryption_cert_pem: str(body.encryption_cert_pem),
    signing_cert_pem: str(body.signing_cert_pem),
    encryption_algorithm: str(body.encryption_algorithm) || 'aes256-cbc',
    key_transport_algorithm: str(body.key_transport_algorithm) || 'rsa-oaep-mgf1p',
    // Omitted means on, so API clients that predate the checkbox keep their rules working.
    transform_enabled: body.transform_enabled === undefined || body.transform_enabled ? 1 : 0,
    transform_rules: typeof body.transform_rules === 'string' ? body.transform_rules.replace(/\r\n/g, '\n') : '',
    // Which transformed attribute supplies the NameID, and which are working values left out of the assertion.
    transform_nameid_attr: str(body.transform_nameid_attr),
    transform_temp_attrs: [...new Set(toArr(body.transform_temp_attrs).map(str).filter(Boolean))],
    access_mode: str(body.access_mode) || 'all',
    access_groups: [...new Set(toArr(body.access_groups).map(Number).filter(Boolean))],
  };

  const pairs = (a, b) => toArr(a).map((x, i) => [str(x), str(toArr(b)[i])]);
  data.maps = pairs(body.map_idp, body.map_saml)
    .filter(([idp, name]) => idp && name).map(([idp_attribute, saml_name]) => ({ idp_attribute, saml_name }));
  data.statics = pairs(body.static_name, body.static_value)
    .filter(([n]) => n).map(([name, value]) => ({ name, value }));
  const groupIds = toArr(body.role_group);
  const roleNames = toArr(body.role_name);
  const roleValues = toArr(body.role_value);
  data.roles = groupIds.map((g, i) => ({
    group_id: Number(g), saml_name: str(roleNames[i]), role_value: str(roleValues[i]),
  })).filter((r) => r.group_id && r.saml_name);

  if (draft && !data.name) data.name = 'Generic SAML Service Provider';
  if (!data.name && !draft) errors.push('Name is required.');
  // Access policy reads reference or application groups, never basis groups straight from a source (Grouper's guidance).
  const roles = rolesOf();
  for (const id of new Set([...data.access_groups, ...data.roles.map((r) => r.group_id)])) {
    if (roles.get(id) !== 'basis') continue;
    const g = db.get('SELECT name FROM groups WHERE id = ?', id);
    errors.push(`${g ? g.name : 'A group'} is a basis group, fed from a source. Grant access through a reference or application group instead.`);
  }
  if (!ACCESS_MODES.includes(data.access_mode)) errors.push('Invalid user access setting.');
  if (!data.acs_urls.length && !draft) errors.push('At least one ACS URL is required.');
  for (const u of data.acs_urls) if (!isHttpUrl(u)) errors.push(`ACS URL is not a valid http(s) URL: ${u}`);
  for (const [label, u] of [['SLO URL', data.slo_url], ['Login URL', data.login_url]]) {
    if (u && !isHttpUrl(u)) errors.push(`${label} is not a valid http(s) URL.`);
  }
  if (!(data.nameid_format in NAMEID_FORMATS)) errors.push('Invalid NameID format.');
  if (!(data.signature_algorithm in SIGNATURE_ALGORITHMS)) errors.push('Invalid signature algorithm.');
  if (!data.sign_response && !data.sign_assertion) {
    errors.push('Enable at least one of "Sign response" or "Sign assertion".');
  }
  if (!['none', 'url', 'upload'].includes(data.metadata_mode)) errors.push('Invalid metadata discovery mode.');
  if (data.metadata_mode === 'url' && data.metadata_url && !isHttpUrl(data.metadata_url)) errors.push('Metadata URL is not a valid http(s) URL.');
  if (data.metadata_mode !== 'url') data.metadata_url = '';
  if (!(data.encryption_algorithm in ENCRYPTION_ALGORITHMS)) errors.push('Invalid assertion encryption algorithm.');
  if (!(data.key_transport_algorithm in KEY_TRANSPORT_ALGORITHMS)) errors.push('Invalid key transport algorithm.');
  if (data.encryption_cert_pem) {
    try {
      data.encryption_cert_pem = normalizeCertificate(data.encryption_cert_pem);
    } catch (e) {
      errors.push(e.message);
    }
  } else if (data.encrypt_assertion) {
    errors.push('Assertion encryption needs the service provider\'s encryption certificate.');
  }
  if (data.signing_cert_pem) {
    try {
      data.signing_cert_pem = normalizeCertificate(data.signing_cert_pem);
    } catch (e) {
      errors.push(`Request signing certificate: ${e.message}`);
    }
  }
  if (data.transform_enabled) errors.push(...parseRules(data.transform_rules).errors);
  if (data.default_relay_state.length > 80) errors.push('Default RelayState must be 80 bytes or fewer (SAML spec).');
  return { data, errors };
}

function writeChildren(id, d) {
  for (const t of ['sp_attribute_map', 'sp_static_attributes', 'sp_role_attributes', 'sp_access_groups']) {
    db.run(`DELETE FROM ${t} WHERE sp_id = ?`, id);
  }
  for (const m of d.maps) {
    db.run('INSERT INTO sp_attribute_map (sp_id, idp_attribute, saml_name) VALUES (?,?,?)', id, m.idp_attribute, m.saml_name);
  }
  for (const s of d.statics) {
    db.run('INSERT INTO sp_static_attributes (sp_id, name, value) VALUES (?,?,?)', id, s.name, s.value);
  }
  for (const g of d.access_groups) {
    db.run('INSERT OR IGNORE INTO sp_access_groups (sp_id, group_id) SELECT ?, id FROM groups WHERE id = ?', id, g);
  }
  for (const r of d.roles) {
    const g = db.get('SELECT name FROM groups WHERE id = ?', r.group_id);
    if (!g) continue;
    db.run('INSERT INTO sp_role_attributes (sp_id, saml_name, group_id, role_value) VALUES (?,?,?,?)',
      id, r.saml_name, r.group_id, r.role_value || g.name);
  }
}

const COLS = ['name', 'description', 'metadata_mode', 'metadata_url', 'encrypt_assertion', 'encryption_cert_pem', 'signing_cert_pem',
  'encryption_algorithm', 'key_transport_algorithm', 'transform_enabled', 'transform_rules', 'transform_nameid_attr', 'transform_temp_attrs', 'sp_entity_id', 'slo_url', 'login_url', 'default_relay_state', 'nameid_format', 'nameid_source',
  'signature_algorithm', 'sign_response', 'sign_assertion', 'groups_attribute', 'grouper_groups', 'access_mode'];

const colValue = (d) => (c) => (c === 'transform_temp_attrs' ? JSON.stringify(d[c]) : d[c]);

function createSp(d) {
  const id = crypto.randomBytes(8).toString('hex');
  const { keyPem, certPem } = generateKeyAndCert(`Pons Identity SP ${id}`);
  db.tx(() => {
    db.run(
      `INSERT INTO service_providers (id, acs_urls, private_key_pem, cert_pem, ${COLS.join(', ')})
       VALUES (?, ?, ?, ?, ${COLS.map(() => '?').join(', ')})`,
      id, JSON.stringify(d.acs_urls), keyPem, certPem, ...COLS.map(colValue(d)));
    writeChildren(id, d);
  });
  return id;
}

function updateSp(id, d) {
  db.tx(() => {
    db.run(
      `UPDATE service_providers SET acs_urls = ?, ${COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      JSON.stringify(d.acs_urls), ...COLS.map(colValue(d)), id);
    writeChildren(id, d);
  });
}

// May this user sign in to the service provider? Disabled for all, enabled for members of chosen groups, or enabled for all.
function userHasAccess(sp, userId) {
  if (sp.access_mode === 'none') return false;
  if (sp.access_mode !== 'groups') return true;
  const allowed = new Set(db.all('SELECT group_id FROM sp_access_groups WHERE sp_id = ?', sp.id).map((r) => r.group_id));
  return effectiveGroupsOf(userId).some((g) => allowed.has(g.id));
}

function regenerateCert(id) {
  const { keyPem, certPem } = generateKeyAndCert(`Pons Identity SP ${id}`);
  db.run('UPDATE service_providers SET private_key_pem = ?, cert_pem = ? WHERE id = ?', keyPem, certPem, id);
}

function deleteSp(id) {
  db.run('DELETE FROM service_providers WHERE id = ?', id);
}

module.exports = { getSp, listSps, blankSp, parseForm, createSp, updateSp, regenerateCert, deleteSp, userHasAccess };
