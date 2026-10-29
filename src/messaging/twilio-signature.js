const crypto = require('crypto');

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Twilio signs each request: HMAC-SHA1 of the full URL and the sorted form fields, with the account's auth token. */
function twilioSignatureOk(url, fields, signature, authToken) {
  const data = url + Object.keys(fields || {}).sort().map((k) => `${k}${fields[k]}`).join('');
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  return typeof signature === 'string' && signature !== '' && same(signature, expected);
}

module.exports = { twilioSignatureOk };
