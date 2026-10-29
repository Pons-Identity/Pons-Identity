const { generateKeyAndCert } = require('../crypto');

// A federation key set and its rollover. Federations publish your metadata to everyone, and copies take days to
// spread, so a new key has to be published well before it is used and the old one kept until nobody needs it:
//
//   active   signs now and is the key others encrypt to
//   next     staged: published in metadata, not yet used
//   previous retired from use but still published (and still able to decrypt) until you retire it
//
// Signing and encryption keys roll together. All functions are pure: they return the new key set to be stored.

const pair = (cn) => {
  const { keyPem, certPem } = generateKeyAndCert(cn);
  return { keyPem, certPem };
};
const generate = (label) => ({ signing: pair(`${label} signing`), encryption: pair(`${label} encryption`) });

const create = (label) => ({ ...generate(label), next: null, previous: null });

const stage = (keys, label) => {
  if (keys.next) throw new Error('A new key is already staged. Activate it or cancel it first.');
  return { ...keys, next: generate(label) };
};

const activate = (keys) => {
  if (!keys.next) throw new Error('There is no staged key to activate.');
  if (keys.previous) throw new Error('Retire the previous key first; only one old key can stay published.');
  return { signing: keys.next.signing, encryption: keys.next.encryption, next: null, previous: { signing: keys.signing, encryption: keys.encryption } };
};

const retire = (keys) => {
  if (!keys.previous) throw new Error('There is no previous key to retire.');
  return { ...keys, previous: null };
};

const cancel = (keys) => {
  if (!keys.next) throw new Error('There is no staged key to cancel.');
  return { ...keys, next: null };
};

const ACTIONS = { stage, activate, retire, cancel };

/** Certificates to publish for `use` ('signing' | 'encryption'): active first, then staged, then previous. */
const published = (keys, use) => [
  { role: 'active', certPem: keys[use].certPem },
  ...(keys.next ? [{ role: 'next', certPem: keys.next[use].certPem }] : []),
  ...(keys.previous ? [{ role: 'previous', certPem: keys.previous[use].certPem }] : []),
];

/** Private keys able to decrypt: what others encrypted to the active, previous or staged certificate. */
const decryptionKeys = (keys) => [keys.encryption, keys.previous && keys.previous.encryption, keys.next && keys.next.encryption]
  .filter(Boolean).map((k) => k.keyPem);

module.exports = { create, generate, stage, activate, retire, cancel, published, decryptionKeys, ACTIONS };
