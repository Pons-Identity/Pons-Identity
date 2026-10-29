import { describe, expect, test } from 'vitest';
import { BLOCKED_TERMS, generatePassphrase, spellsBlockedTerm } from './passphrase.js';
import WORDS from './passphrase-words.js';

const SMALL = ['alpha', 'bravo', 'cedar', 'delta'];

describe('generatePassphrase', () => {
  test('joins the requested number of words with the separator', () => {
    const phrase = generatePassphrase({ words: 5, separator: '.' }, SMALL);
    const parts = phrase.split('.');
    expect(parts).toHaveLength(5);
    parts.forEach((p) => expect(SMALL).toContain(p));
  });

  test('capitalizes only when asked, and the separator can be empty', () => {
    expect(generatePassphrase({ words: 3, separator: '' }, SMALL)).toMatch(/^[a-z]+$/);
    expect(generatePassphrase({ words: 3, separator: '', capitalize: true }, SMALL)).toMatch(/^([A-Z][a-z]+){3}$/);
  });

  test('a two-digit number is added to the end of one word only when asked', () => {
    expect(generatePassphrase({ words: 2, separator: '-' }, SMALL)).not.toMatch(/\d/);
    const phrase = generatePassphrase({ words: 3, separator: '-', includeNumber: true }, SMALL);
    expect(phrase).toMatch(/^[a-z]+-[a-z]+-[a-z]+$|^[a-z]+\d{2}-[a-z]+-[a-z]+$|^[a-z]+-[a-z]+\d{2}-[a-z]+$|^[a-z]+-[a-z]+-[a-z]+\d{2}$/);
  });

  test('the number lands on different words, so its position varies', () => {
    const positions = new Set();
    for (let i = 0; i < 200; i++) {
      const phrase = generatePassphrase({ words: 4, separator: '-', includeNumber: true }, SMALL);
      positions.add(phrase.split('-').findIndex((p) => /\d/.test(p)));
    }
    expect([...positions].sort()).toEqual([0, 1, 2, 3]);
  });

  test('the default list is the EFF wordlist, and a word of it is what comes out', () => {
    expect(WORDS).toHaveLength(7776);
    expect(WORDS).toContain('abacus');
    const phrase = generatePassphrase({ words: 4 });
    phrase.split('-').forEach((w) => expect(WORDS).toContain(w));
  });

  test('every word of a small list is drawn', () => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(generatePassphrase({ words: 1, separator: '' }, SMALL));
    expect([...seen].sort()).toEqual([...SMALL].sort());
  });

  test('a word that contains a blocked term is never used', () => {
    expect(generatePassphrase({ words: 3, separator: '' }, ['shitake', 'alpha'])).toBe('alphaalphaalpha');
  });

  test('no passphrase spells a blocked term when two of its words run together', () => {
    for (let i = 0; i < 300; i++) {
      const phrase = generatePassphrase({ words: 2, separator: '' }, ['sh', 'it', 'ocean', 'cart']);
      expect(phrase).not.toMatch(/shit/i);
    }
  });

  test('a list with no usable words fails rather than returning one', () => {
    expect(() => generatePassphrase({ words: 2 }, ['shitake'])).toThrow(/usable words/);
  });
});

describe('spellsBlockedTerm', () => {
  test('finds a term whatever the capitals, separators or digits, and only when it is spelled', () => {
    expect(spellsBlockedTerm(['Sh', 'it'])).toBe(true);
    expect(spellsBlockedTerm(['s-h', 'i_t'])).toBe(true);
    expect(spellsBlockedTerm(['classic', 'ocean'])).toBe(true);
    expect(spellsBlockedTerm(['alpha', 'bravo'])).toBe(false);
    expect(BLOCKED_TERMS.every((t) => t === t.toLowerCase() && /^[a-z]+$/.test(t))).toBe(true);
  });
});
