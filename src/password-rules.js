const crypto = require('crypto');
const db = require('./db');
const { verifyPassword } = require('./crypto');

// Password policies are named sets of password rules that sign-in policies point at (policies.password_policy_id). Where several apply to a
// person the strictest value of each rule wins. This module turns rows into one combined rule set and checks a candidate password against it.

const MAX_PASSWORD_LENGTH = 256; // also bounds the work a restricted-pattern regex can be made to do
const HISTORY_LIMIT = 100;       // stored per person; "never reuse" checks this many previous passwords
const MAX_HISTORY_COUNT = 24;
const MAX_WORDS = 500;
const MAX_PATTERNS = 50;
const MAX_WORD_LENGTH = 64;
const MAX_PATTERN_LENGTH = 200;
const SCORE_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
const HIBP_TIMEOUT_MS = 4000;

const list = (json) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };

// A password rule set in the shape of a password_policies row, with every rule off.
const EMPTY_ROW = {
  min_length: 0, require_lowercase: 0, require_uppercase: 0, require_digit: 0, require_symbol: 0, min_character_classes: 0,
  block_personal_info: 0, restricted_words: '[]', restricted_patterns: '[]', history_count: 0, history_forbid_all: 0,
  hibp_enabled: 0, hibp_min_count: 1, hibp_block_on_error: 0, zxcvbn_enabled: 0, zxcvbn_min_score: 0,
};

/** A stored rule set with any column it lacks filled in, so rules saved by an earlier version still combine. */
const normalize = (row) => ({ ...EMPTY_ROW, ...row });

/** A password policy row as the console and API see it. */
function view(r) {
  return {
    id: r.id, name: r.name, description: r.description,
    min_length: r.min_length,
    require_lowercase: Boolean(r.require_lowercase), require_uppercase: Boolean(r.require_uppercase),
    require_digit: Boolean(r.require_digit), require_symbol: Boolean(r.require_symbol),
    min_character_classes: r.min_character_classes,
    block_personal_info: Boolean(r.block_personal_info),
    restricted_words: list(r.restricted_words), restricted_patterns: list(r.restricted_patterns),
    history_count: r.history_count, history_forbid_all: Boolean(r.history_forbid_all),
    hibp_enabled: Boolean(r.hibp_enabled), hibp_min_count: r.hibp_min_count, hibp_block_on_error: Boolean(r.hibp_block_on_error),
    zxcvbn_enabled: Boolean(r.zxcvbn_enabled), zxcvbn_min_score: r.zxcvbn_min_score,
  };
}

/** Combines password policy rows into the strictest rule set. */
function combine(rows) {
  const hibp = rows.filter((r) => r.hibp_enabled);
  const strength = rows.filter((r) => r.zxcvbn_enabled);
  return {
    minLength: Math.max(0, ...rows.map((r) => r.min_length)),
    requireLowercase: rows.some((r) => r.require_lowercase),
    requireUppercase: rows.some((r) => r.require_uppercase),
    requireDigit: rows.some((r) => r.require_digit),
    requireSymbol: rows.some((r) => r.require_symbol),
    minCharacterClasses: Math.max(0, ...rows.map((r) => r.min_character_classes)),
    blockPersonalInfo: rows.some((r) => r.block_personal_info),
    restrictedWords: [...new Set(rows.flatMap((r) => list(r.restricted_words).map((w) => w.toLowerCase())))],
    restrictedPatterns: [...new Set(rows.flatMap((r) => list(r.restricted_patterns)))],
    // count = how many previous passwords may not be reused; all = none of the remembered ones may be.
    history: { count: Math.max(0, ...rows.map((r) => r.history_count)), all: rows.some((r) => r.history_forbid_all) },
    hibp: hibp.length ? { minCount: Math.min(...hibp.map((r) => r.hibp_min_count)), blockOnError: hibp.some((r) => r.hibp_block_on_error) } : null,
    zxcvbn: strength.length ? { minScore: Math.max(...strength.map((r) => r.zxcvbn_min_score)) } : null,
  };
}

/* ------------------------------ Restricted patterns ----------------------------- */

// "/regex/flags" picks the flags (g and y are ignored); anything else is the bare source, case-sensitive.
function compilePattern(text) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(text);
  const [source, flags] = m ? [m[1], m[2].replace(/[gy]/g, '')] : [text, ''];
  return new RegExp(source, flags);
}

// A group that is repeated and itself repeats ("(a+)+") is the classic way to make a regex take exponential time.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

/** Returns an error message for a pattern that cannot be used, or '' when it is fine. */
function patternError(text) {
  if (text.length > MAX_PATTERN_LENGTH) return `A pattern is longer than ${MAX_PATTERN_LENGTH} characters.`;
  if (NESTED_QUANTIFIER.test(text)) return `The pattern ${text} repeats a repeated group, which can make sign-in slow. Rewrite it without nested quantifiers.`;
  try { compilePattern(text); } catch (e) { return `The pattern ${text} is not a valid regular expression: ${e.message.replace(/^Invalid regular expression: /, '')}`; }
  return '';
}

/* ----------------------------------- zxcvbn ------------------------------------ */

let factory = null;
function zxcvbn(password, userInputs = []) {
  if (!factory) {
    const { ZxcvbnFactory } = require('@zxcvbn-ts/core');
    const common = require('@zxcvbn-ts/language-common');
    const en = require('@zxcvbn-ts/language-en');
    factory = new ZxcvbnFactory({ translations: en.translations, graphs: common.adjacencyGraphs, dictionary: { ...common.dictionary, ...en.dictionary } });
  }
  return factory.check(password, userInputs);
}

/* --------------------------------- HaveIBeenPwned ------------------------------- */

// Only the first five characters of the SHA-1 of the password leave this server (k-anonymity range API).
const hibp = { fetch: (...a) => globalThis.fetch(...a), baseUrl: () => (process.env.HIBP_API_URL || 'https://api.pwnedpasswords.com').replace(/\/$/, '') };

/** How many times the password appears in known breaches. Throws when the service cannot be reached. */
async function pwnedCount(password) {
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const res = await hibp.fetch(`${hibp.baseUrl()}/range/${sha1.slice(0, 5)}`, {
    headers: { 'Add-Padding': 'true', 'User-Agent': 'PonsIdentity' }, signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HaveIBeenPwned answered ${res.status}`);
  for (const line of (await res.text()).split('\n')) {
    const [suffix, count] = line.trim().split(':');
    if (suffix === sha1.slice(5)) return Number(count) || 0;
  }
  return 0;
}

/* --------------------------------- Personal info -------------------------------- */

function personalTokens(user) {
  if (!user) return [];
  const raw = [user.username, user.first_name, user.last_name, user.display_name, (user.email || '').split('@')[0]];
  return [...new Set(raw.filter(Boolean).flatMap((v) => String(v).toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((t) => t.length >= 3))];
}

/* ---------------------------------- History ------------------------------------- */

function reusedPassword(userId, password, { count, all }) {
  if (!count && !all) return false;
  const user = db.get('SELECT password_hash FROM users WHERE id = ?', userId);
  const hashes = [user && user.password_hash, ...db.all('SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, HISTORY_LIMIT).map((r) => r.password_hash)]
    .filter(Boolean);
  const recent = [...new Set(hashes)].slice(0, all ? HISTORY_LIMIT : count);
  return recent.some((h) => verifyPassword(password, h));
}

/* ---------------------------------- Checking ------------------------------------ */

/**
 * What went wrong with `password` under `rules`, as a list of messages (empty = acceptable). Never names a restricted word or
 * pattern. `profile` stands in for the person when there is no account yet (see policies.draftPasswordErrors).
 */
async function evaluate(userId, password, rules, { minLength = 0, profile = null } = {}) {
  const errors = [];
  if (typeof password !== 'string') return ['Choose a new password.'];
  if (password.length > MAX_PASSWORD_LENGTH) return [`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`];
  const need = Math.max(minLength, rules.minLength);
  if (password.length < need) errors.push(`Password must be at least ${need} characters.`);

  const classes = [/\p{Ll}/u.test(password), /\p{Lu}/u.test(password), /\p{N}/u.test(password), /[^\p{L}\p{N}]/u.test(password)];
  if (rules.requireLowercase && !classes[0]) errors.push('Password must include a lowercase letter.');
  if (rules.requireUppercase && !classes[1]) errors.push('Password must include an uppercase letter.');
  if (rules.requireDigit && !classes[2]) errors.push('Password must include a digit.');
  if (rules.requireSymbol && !classes[3]) errors.push('Password must include a symbol or space.');
  if (rules.minCharacterClasses && classes.filter(Boolean).length < rules.minCharacterClasses) {
    errors.push(`Password must mix at least ${rules.minCharacterClasses} of: lowercase, uppercase, digits, symbols.`);
  }

  const lower = password.toLowerCase();
  if (rules.restrictedWords.some((w) => w && lower.includes(w))) errors.push('Password contains a word that is not allowed.');
  if (rules.restrictedPatterns.some((p) => { try { return compilePattern(p).test(password); } catch { return false; } })) {
    errors.push('Password matches a pattern that is not allowed.');
  }
  const user = userId ? db.get('SELECT * FROM users WHERE id = ?', userId) : profile;
  const personal = personalTokens(user);
  if (rules.blockPersonalInfo && personal.some((t) => lower.includes(t))) errors.push('Password must not contain your name, username or email address.');

  if (reusedPassword(userId, password, rules.history)) {
    errors.push(rules.history.all ? 'You have used this password before. Choose one you have never used.'
      : `This matches one of your last ${rules.history.count} passwords. Choose a new one.`);
  }

  if (rules.zxcvbn && rules.zxcvbn.minScore > 0 && !errors.length) {
    const r = zxcvbn(password, personal);
    if (r.score < rules.zxcvbn.minScore) {
      const hint = r.feedback.warning || (r.feedback.suggestions || [])[0] || '';
      errors.push(`Password is too easy to guess (${SCORE_LABELS[r.score].toLowerCase()}); ${SCORE_LABELS[rules.zxcvbn.minScore].toLowerCase()} or better is required.${hint ? ` ${hint}` : ''}`);
    }
  }

  // The network check goes last, so a password that is already refused is never sent anywhere.
  if (rules.hibp && !errors.length) {
    try {
      if (await pwnedCount(password) >= rules.hibp.minCount) errors.push('This password has appeared in a known data breach. Choose a different one.');
    } catch (e) {
      console.error('HaveIBeenPwned check failed:', e.message);
      if (rules.hibp.blockOnError) errors.push('Passwords cannot be checked against known breaches right now. Try again later.');
    }
  }
  return errors;
}

/** What a person is told about the rules while choosing a password. Restricted words and patterns are not revealed. */
function describe(rules, minLength) {
  const need = Math.max(minLength, rules.minLength);
  const items = [`At least ${need} characters`];
  const kinds = [[rules.requireLowercase, 'a lowercase letter'], [rules.requireUppercase, 'an uppercase letter'], [rules.requireDigit, 'a digit'], [rules.requireSymbol, 'a symbol']]
    .filter(([on]) => on).map(([, t]) => t);
  if (kinds.length) items.push(`Include ${kinds.join(', ')}`);
  if (rules.minCharacterClasses) items.push(`Mix at least ${rules.minCharacterClasses} of lowercase, uppercase, digits and symbols`);
  if (rules.blockPersonalInfo) items.push('Do not use your name, username or email address');
  if (rules.restrictedWords.length || rules.restrictedPatterns.length) items.push('Avoid words and patterns your organization does not allow');
  if (rules.history.all) items.push('Never reuse a previous password');
  else if (rules.history.count) items.push(`Do not reuse your last ${rules.history.count} passwords`);
  if (rules.hibp) items.push('Must not appear in known data breaches');
  if (rules.zxcvbn && rules.zxcvbn.minScore > 0) items.push(`Strength must be ${SCORE_LABELS[rules.zxcvbn.minScore].toLowerCase()} or better`);
  return { min_length: need, requirements: items, strength: rules.zxcvbn ? { min_score: rules.zxcvbn.minScore } : null };
}

module.exports = {
  MAX_PASSWORD_LENGTH, HISTORY_LIMIT, MAX_HISTORY_COUNT, MAX_WORDS, MAX_PATTERNS, MAX_WORD_LENGTH, MAX_PATTERN_LENGTH, SCORE_LABELS,
  view, normalize, combine, compilePattern, patternError, zxcvbn, pwnedCount, evaluate, describe, hibp,
};
