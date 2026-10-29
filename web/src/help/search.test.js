import { expect, test } from 'vitest';
import { ARTICLES } from './articles.js';
import { searchArticles } from './search.js';

const article = (over) => ({ slug: 'x', section: 'Groups', title: 'T', summary: 'S', visible: () => true, body: [], ...over });

test('every word must appear somewhere in the article', () => {
  const articles = [article({ slug: 'a', summary: 'Find a group by name' }), article({ slug: 'b', section: 'Your account', summary: 'Find a user' })];
  expect(searchArticles(articles, 'find group').results.map((a) => a.slug)).toEqual(['a']);
  expect(searchArticles(articles, 'find').total).toBe(2);
  expect(searchArticles(articles, 'nowhere').total).toBe(0);
});

test('text in steps, tables and tips is searched too', () => {
  const articles = [article({
    slug: 'deep',
    body: [{ steps: ['Select **Turn on**.'] }, { table: { head: ['Field'], rows: [['Lifetime in days']] } }, { tip: 'Keep a spare key.' }],
  })];
  expect(searchArticles(articles, 'turn on').total).toBe(1);
  expect(searchArticles(articles, 'lifetime').total).toBe(1);
  expect(searchArticles(articles, 'spare').total).toBe(1);
});

test('articles whose title holds the words come first', () => {
  const articles = [
    article({ slug: 'body-hit', title: 'Other', summary: 'Mentions passkey' }),
    article({ slug: 'title-hit', title: 'Add a passkey', summary: 'Register one' }),
  ];
  expect(searchArticles(articles, 'passkey').results.map((a) => a.slug)).toEqual(['title-hit', 'body-hit']);
});

test('a blank query matches nothing, and matching ignores case', () => {
  expect(searchArticles(ARTICLES, '   ')).toEqual({ results: [], total: 0 });
  expect(searchArticles(ARTICLES, 'PASSKEY').total).toBeGreaterThan(0);
});
