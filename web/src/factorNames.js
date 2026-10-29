// Names for the sign-in factors a policy can allow. A method is 'totp', 'webauthn', or 'channel:mode' for an email, SMS or voice way
// (the server's factor_types list uses these); a bare channel name means every way it is on.
const TYPE = { totp: 'Authenticator app', webauthn: 'Security key / passkey', email: 'Email', sms: 'Text message', voice: 'Phone call' };
const MODE = { code: 'code', number_match: 'number matching', yes_no: 'yes or no', yes_no_verified: 'yes or no with the code' };

export const factorName = (method) => {
  const [type, mode] = String(method).split(':');
  if (!TYPE[type]) return method;
  return mode ? `${TYPE[type]}, ${MODE[mode] || mode}` : TYPE[type];
};
