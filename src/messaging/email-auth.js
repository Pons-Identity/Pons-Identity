// Is an inbound email reply really from who it says? A reply can approve a sign-in, and the From address is trivial to forge, so
// the receiving provider's own verdicts on SPF, DKIM and DMARC are read and the administrator chooses which must have passed
// (Settings > Messaging). A check that is required but that the provider did not report counts as failed.
//
// Only the provider's verdict is trusted: Amazon SES reports verdicts as fields of the notification; Mailgun adds
// X-Mailgun-* fields; Postmark and anything else is read from the Authentication-Results and Received-SPF headers, using
// the first of each (the one the receiving server added last, above anything the sender put in the message).

const CHECKS = ['spf', 'dkim', 'dmarc'];
const pass = (v) => String(v || '').trim().toLowerCase() === 'pass';

/** { spf, dkim, dmarc } booleans from the text of an Authentication-Results header. DKIM passes when any signature does. */
function fromAuthenticationResults(value) {
  const out = {};
  for (const m of String(value || '').matchAll(/\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) {
    const k = m[1].toLowerCase();
    out[k] = out[k] || pass(m[2]);
  }
  return out;
}

/** Verdicts from a list of headers, [{ name, value }] in the order they appear in the message. */
function fromHeaders(headers) {
  const list = Array.isArray(headers) ? headers : [];
  const first = (name) => list.find((h) => h && String(h.name || h.Name || '').toLowerCase() === name);
  const value = (h) => (h ? h.value ?? h.Value : '');
  const out = fromAuthenticationResults(value(first('authentication-results')));
  const spf = first('received-spf');
  if (spf && out.spf === undefined) out.spf = /^\s*pass\b/i.test(value(spf));
  return out;
}

/** Verdicts from an SES receipt: { spfVerdict: { status }, dkimVerdict, dmarcVerdict }. */
const fromSes = (receipt = {}) => ({
  spf: pass(receipt.spfVerdict?.status), dkim: pass(receipt.dkimVerdict?.status), dmarc: pass(receipt.dmarcVerdict?.status),
});

/** Verdicts from Mailgun's route fields plus, for DMARC, the headers it forwards as JSON. */
function fromMailgun(fields) {
  let headers = [];
  try { headers = JSON.parse(fields['message-headers'] || '[]').map(([name, value]) => ({ name, value })); } catch { /* no usable headers */ }
  const fromHeader = fromHeaders(headers);
  return {
    spf: fields['X-Mailgun-Spf'] !== undefined ? pass(fields['X-Mailgun-Spf']) : fromHeader.spf,
    dkim: fields['X-Mailgun-Dkim-Check-Result'] !== undefined ? pass(fields['X-Mailgun-Dkim-Check-Result']) : fromHeader.dkim,
    dmarc: fromHeader.dmarc,
  };
}

/** { ok, failed } for the checks `required` ({ spf, dkim, dmarc } booleans) against the provider's `verdicts`. */
function check(required, verdicts) {
  const failed = CHECKS.filter((k) => required && required[k] && !(verdicts && verdicts[k] === true));
  return { ok: !failed.length, failed };
}

module.exports = { check, fromHeaders, fromSes, fromMailgun, fromAuthenticationResults, CHECKS };
