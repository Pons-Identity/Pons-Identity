// Form model for the application page. Rows are objects so each list can be edited with RepeaterRows and tables.
// toForm / toPayload convert to and from the field names /api/admin/sps expects.

export const METADATA_MODES = [
  { value: 'none', label: 'None (manual input)' },
  { value: 'url', label: 'Metadata XML URL' },
  { value: 'upload', label: 'Metadata XML upload' },
];

// Rules are stored as `target = expression` lines; the form edits them as rows of { saml_name, expression, nameid, temp }.
const RULE_LINE = /^\s*("(?:[^"\\]|\\.)*"|[^\s=]+)\s*=\s*(.+?)\s*$/;
function parseTransformRows(sp) {
  const temp = new Set(sp.transform_temp_attrs || []);
  return String(sp.transform_rules || '').split(/\r?\n/).flatMap((line) => {
    const m = RULE_LINE.exec(line);
    if (!m || line.trim().startsWith('#')) return [];
    const name = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/\\(.)/g, '$1') : m[1];
    return [{ saml_name: name, expression: m[2], nameid: name === sp.transform_nameid_attr, temp: temp.has(name) }];
  });
}

const quoteName = (n) => (/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(n) ? n : `"${n.replace(/["\\]/g, '\\$&')}"`);

// The server keeps one role row per group. The form shows one mapping per SP role, with all of its groups.
function parseRoleMappings(roles) {
  const byRole = new Map();
  for (const r of roles || []) {
    const role = r.role_value || r.group_name || '';
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(String(r.group_id));
  }
  return [...byRole].map(([role, groups]) => ({ role, groups }));
}

export function toForm(sp) {
  return {
    name: sp.name || '',
    description: sp.description || '',
    metadata_mode: sp.metadata_mode || 'none',
    metadata_url: sp.metadata_url || '',
    sp_entity_id: sp.sp_entity_id || '',
    acs: (sp.acs_urls?.length ? sp.acs_urls : ['']).map((url) => ({ url })),
    slo_url: sp.slo_url || '',
    login_url: sp.login_url || '',
    default_relay_state: sp.default_relay_state || '',
    nameid_format: sp.nameid_format || 'emailAddress',
    nameid_source: sp.nameid_source || 'email',
    signature_algorithm: sp.signature_algorithm || 'sha256',
    sign_response: Boolean(sp.sign_response),
    sign_assertion: Boolean(sp.sign_assertion),
    encrypt_assertion: Boolean(sp.encrypt_assertion),
    encryption_cert_pem: sp.encryption_cert_pem || '',
    encryption_cert: sp.encryption_cert || null,
    encryption_cert_name: '',
    signing_cert_pem: sp.signing_cert_pem || '',
    signing_cert: sp.signing_cert || null,
    signing_cert_name: '',
    encryption_algorithm: sp.encryption_algorithm || 'aes256-cbc',
    key_transport_algorithm: sp.key_transport_algorithm || 'rsa-oaep-mgf1p',
    // IdP-attribute and static-value mappings share one table; `kind` says which.
    attrs: [
      ...(sp.maps || []).map((m) => ({ kind: 'idp', source: m.idp_attribute, saml_name: m.saml_name })),
      ...(sp.statics || []).map((s) => ({ kind: 'static', source: s.value, saml_name: s.name })),
    ],
    groups_attribute: sp.groups_attribute || '',
    grouper_groups: Boolean(sp.grouper_groups),
    access_mode: sp.access_mode || 'all',
    access_groups: (sp.access_groups || []).map(String),
    roleMappings: parseRoleMappings(sp.roles),
    transform_enabled: sp.transform_enabled === undefined ? true : Boolean(sp.transform_enabled),
    transforms: parseTransformRows(sp),
  };
}

export function toPayload(f) {
  const idp = f.attrs.filter((a) => a.kind === 'idp');
  const statics = f.attrs.filter((a) => a.kind === 'static');
  const rows = f.transforms.filter((t) => t.saml_name.trim() && t.expression.trim());
  // A mapping without a role or without groups sends nothing. Every role goes out under the attribute name.
  const roles = f.roleMappings.filter((m) => m.role.trim() && m.groups.length);
  return {
    name: f.name,
    description: f.description,
    metadata_mode: f.metadata_mode,
    metadata_url: f.metadata_url,
    sp_entity_id: f.sp_entity_id,
    acs_url: f.acs.map((a) => a.url),
    slo_url: f.slo_url,
    login_url: f.login_url,
    default_relay_state: f.default_relay_state,
    nameid_format: f.nameid_format,
    nameid_source: f.nameid_source,
    signature_algorithm: f.signature_algorithm,
    sign_response: f.sign_response,
    sign_assertion: f.sign_assertion,
    encrypt_assertion: f.encrypt_assertion,
    encryption_cert_pem: f.encryption_cert_pem,
    signing_cert_pem: f.signing_cert_pem,
    encryption_algorithm: f.encryption_algorithm,
    key_transport_algorithm: f.key_transport_algorithm,
    groups_attribute: f.groups_attribute,
    grouper_groups: f.grouper_groups,
    access_mode: f.access_mode,
    access_groups: f.access_mode === 'groups' ? f.access_groups.map(Number) : [],
    map_idp: idp.map((a) => a.source),
    map_saml: idp.map((a) => a.saml_name),
    static_name: statics.map((a) => a.saml_name),
    static_value: statics.map((a) => a.source),
    role_group: roles.flatMap((m) => m.groups),
    role_name: roles.flatMap((m) => m.groups.map(() => f.groups_attribute)),
    role_value: roles.flatMap((m) => m.groups.map(() => m.role.trim())),
    transform_enabled: f.transform_enabled,
    transform_rules: rows.map((t) => `${quoteName(t.saml_name.trim())} = ${t.expression.replace(/\s*\n\s*/g, ' ').trim()}`).join('\n'),
    transform_nameid_attr: rows.find((t) => t.nameid)?.saml_name.trim() || '',
    transform_temp_attrs: rows.filter((t) => t.temp).map((t) => t.saml_name.trim()),
  };
}

// Merge parsed SP metadata into the form, keeping what the metadata does not say.
export function applyMetadata(f, d) {
  return {
    ...f,
    name: f.name || d.name || '',
    sp_entity_id: d.sp_entity_id || f.sp_entity_id,
    slo_url: d.slo_url || f.slo_url,
    nameid_format: d.nameid_format || f.nameid_format,
    acs: d.acs_urls?.length ? d.acs_urls.map((url) => ({ url })) : f.acs,
    attrs: d.maps?.length
      ? [...d.maps.map((m) => ({ kind: 'idp', source: m.idp_attribute, saml_name: m.saml_name })), ...f.attrs.filter((a) => a.kind === 'static')]
      : f.attrs,
    encryption_cert_pem: d.encryption_cert_pem || f.encryption_cert_pem,
    encryption_cert: d.encryption_cert_pem ? null : f.encryption_cert,
    encryption_cert_name: d.encryption_cert_pem ? 'From metadata' : f.encryption_cert_name,
    signing_cert_pem: d.signing_cert_pem || f.signing_cert_pem,
    signing_cert: d.signing_cert_pem ? null : f.signing_cert,
    signing_cert_name: d.signing_cert_pem ? 'From metadata' : f.signing_cert_name,
  };
}

export const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('Could not read the file.'));
  r.readAsText(file);
});
