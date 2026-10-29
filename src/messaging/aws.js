const crypto = require('crypto');

// AWS Signature Version 4, for calling AWS APIs such as SES with an access key. Only what the messaging providers need:
// sign one request and return the Authorization header and the date header to send with it.

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Sign a request. `headers` must include `host` and `x-amz-date`; every header in it is signed, so send exactly those.
 * `amzDate` is the time in the form 20150830T123600Z. Returns the Authorization header value.
 */
function authorization({ method, path, query = '', headers, body = '', region, service, accessKeyId, secretAccessKey, amzDate }) {
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [method, path, query, canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** The x-amz-date value for a time, e.g. 20150830T123600Z. */
const amzDateOf = (when = new Date()) => when.toISOString().replace(/[:-]|\.\d{3}/g, '');

module.exports = { authorization, amzDateOf, sha256 };
