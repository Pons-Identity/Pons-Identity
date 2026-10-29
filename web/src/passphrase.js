import WORDS from './passphrase-words.js';

// Random passphrases for the password forms. Each word is 1 in 7,776 (about 12.9 bits), so four words give about 52 bits
// before the optional capital letters and number. Randomness comes from the browser's crypto source, and a draw that would
// favour some words is taken again, so every word is equally likely.

// Words that offend, or that spell something offensive when two of them run together. Matched against lowercase letters only,
// so capitals, separators and digits do not hide a term. This is a starting list: review it for your community.
export const BLOCKED_TERMS = [
  'anal', 'anus', 'ass', 'asshole', 'bastard', 'bitch', 'boob', 'chink', 'cock', 'cum', 'cunt', 'dick', 'dyke', 'fag', 'faggot',
  'fuck', 'gook', 'hitler', 'jizz', 'kike', 'naked', 'nazi', 'nigga', 'nigger', 'nude', 'penis', 'porn', 'pussy', 'rape', 'rapist',
  'retard', 'semen', 'sex', 'shit', 'slut', 'spic', 'tranny', 'twat', 'vagina', 'wank', 'whore',
];

const lettersOf = (word) => word.toLowerCase().replace(/[^a-z]/g, '');

// The words that may be used: any word containing a blocked term is left out, so a term can only ever form across a boundary.
const usable = new Map();
function usableWords(list) {
  if (!usable.has(list)) usable.set(list, list.filter((w) => !BLOCKED_TERMS.some((t) => lettersOf(w).includes(t))));
  return usable.get(list);
}

// Whether the words, run together, spell a blocked term.
export function spellsBlockedTerm(words) {
  const joined = words.map(lettersOf).join('');
  return BLOCKED_TERMS.some((t) => joined.includes(t));
}

// A uniform integer below n, without the bias a plain modulus would add when n is not a power of two.
function randomBelow(n) {
  const limit = 2 ** 32 - (2 ** 32 % n);
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0] < limit) return draw[0] % n;
  }
}

const MAX_DRAWS = 100;

/**
 * A passphrase of `words` random words joined by `separator`. `capitalize` upper-cases the first letter of each word;
 * `includeNumber` adds a random two-digit number to the end of one randomly chosen word. `list` defaults to the EFF wordlist.
 * A draw whose words spell a blocked term when run together is discarded and drawn again.
 */
export function generatePassphrase({ words = 4, separator = '-', capitalize = false, includeNumber = false } = {}, list = WORDS) {
  const pool = usableWords(list);
  if (!pool.length) throw new Error('The word list has no usable words.');
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const picked = Array.from({ length: words }, () => pool[randomBelow(pool.length)]);
    if (spellsBlockedTerm(picked)) continue;
    const parts = picked.map((w) => (capitalize ? w[0].toUpperCase() + w.slice(1) : w));
    // The number goes on the end of one random word, so its place in the passphrase is not a giveaway.
    if (includeNumber) parts[randomBelow(parts.length)] += String(randomBelow(100)).padStart(2, '0');
    return parts.join(separator);
  }
  throw new Error('No passphrase without a blocked term could be drawn from this list.');
}
