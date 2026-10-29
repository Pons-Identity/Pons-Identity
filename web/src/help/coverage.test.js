import { expect, test } from 'vitest';
import { ARTICLES, SECTIONS } from './articles.js';

test('help slugs are unique and every section has an article', () => {
  const slugs = ARTICLES.map((a) => a.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  for (const s of SECTIONS) expect(ARTICLES.some((a) => a.section === s), s).toBe(true);
  for (const a of ARTICLES) expect(SECTIONS.includes(a.section), a.slug).toBe(true);
});

test('internal help links point at articles that exist', () => {
  const slugs = new Set(ARTICLES.map((a) => a.slug));
  for (const a of ARTICLES) {
    for (const m of JSON.stringify(a.body).matchAll(/\]\(\/help\/([a-z0-9-]+)\)/g)) expect(slugs.has(m[1]), `${a.slug} -> ${m[1]}`).toBe(true);
  }
});

test('the migration guides the Migration tab links to are registered', () => {
  for (const slug of ['migrate-from-shibboleth', 'migrate-from-okta', 'migrate-from-microsoft', 'migrate-from-another-provider']) {
    expect(ARTICLES.some((a) => a.slug === slug), slug).toBe(true);
  }
});
