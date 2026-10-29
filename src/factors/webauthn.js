const sw = require('@simplewebauthn/server');
const appSettings = require('../app-settings');
const { baseUrl } = require('../config');

// FIDO2 / WebAuthn: security keys and passkeys. The relying party is this server's own origin, so a key registered here is
// useless on a look-alike site, which is what makes it phishing resistant. Attestation is not requested: we need the public key,
// not proof of the key's make. Challenges are kept by the caller (in the session) and are single use.

const url = new URL(baseUrl);
const rp = () => ({ id: url.hostname, name: appSettings.productName(), origin: url.origin });

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

const credentialOf = (row) => JSON.parse(row.credential);

function registrationOptions(user, existingRows, userVerification) {
  const r = rp();
  return sw.generateRegistrationOptions({
    rpName: r.name, rpID: r.id, userName: user.username, userDisplayName: user.display_name || user.username,
    userID: new TextEncoder().encode(user.guid), attestationType: 'none',
    excludeCredentials: existingRows.map((row) => ({ id: row.credential_id, transports: credentialOf(row).transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification },
  });
}

/** Returns { credentialId, credential } to store, or throws. */
async function verifyRegistration(response, expectedChallenge, userVerification) {
  const r = rp();
  const v = await sw.verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: r.origin, expectedRPID: r.id, requireUserVerification: userVerification === 'required' });
  if (!v.verified) throw new Error('not verified');
  const c = v.registrationInfo.credential;
  return {
    credentialId: c.id,
    credential: { publicKey: b64(c.publicKey), counter: c.counter, transports: c.transports || response.response?.transports || [],
      deviceType: v.registrationInfo.credentialDeviceType, backedUp: v.registrationInfo.credentialBackedUp },
  };
}

function authenticationOptions(rows, userVerification) {
  return sw.generateAuthenticationOptions({ rpID: rp().id, userVerification,
    allowCredentials: rows.map((row) => ({ id: row.credential_id, transports: credentialOf(row).transports })) });
}

/** Verifies a sign-in assertion against the stored key. Returns the new signature counter, or throws. */
async function verifyAuthentication(response, expectedChallenge, row, userVerification) {
  const r = rp();
  const cred = credentialOf(row);
  const v = await sw.verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: r.origin, expectedRPID: r.id,
    requireUserVerification: userVerification === 'required',
    credential: { id: row.credential_id, publicKey: fromB64(cred.publicKey), counter: cred.counter, transports: cred.transports } });
  if (!v.verified) throw new Error('not verified');
  return { counter: v.authenticationInfo.newCounter, userVerified: v.authenticationInfo.userVerified };
}

module.exports = { registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication, rp };
