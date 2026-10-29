const crypto = require('crypto');

// Active Directory objectGUID as displayed by tools: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
function newGuid() {
  return crypto.randomUUID();
}

// Azure AD / ADFS "ImmutableID": base64 of the objectGUID in AD's mixed-endian byte order.
function immutableId(guid) {
  const b = Buffer.from(guid.replace(/-/g, ''), 'hex');
  const out = Buffer.from([
    b[3], b[2], b[1], b[0],
    b[5], b[4],
    b[7], b[6],
    ...b.subarray(8),
  ]);
  return out.toString('base64');
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

module.exports = { newGuid, immutableId, GUID_RE };
