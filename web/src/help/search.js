// Search over help articles. Like the console search, every word must appear somewhere in the article, and an article
// whose title holds every word is listed first.

// The text of one body block, with its steps, cells and notes run together.
function textOf(block) {
  if (typeof block === 'string') return block;
  if (block.steps || block.bullets) return (block.steps || block.bullets).join(' ');
  if (block.table) return [...block.table.head, ...block.table.rows.flat()].join(' ');
  return block.heading || block.code || block.tip || block.warning || '';
}

const lower = (s) => s.toLowerCase();

/** The articles in `articles` that match `text`: { results, total }, the same shape the console search returns. */
export function searchArticles(articles, text) {
  const words = lower(String(text ?? '').trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], total: 0 };
  const hits = articles.filter((a) => {
    const haystack = lower([a.title, a.summary, a.section, ...a.body.map(textOf)].join(' '));
    return words.every((w) => haystack.includes(w));
  });
  const inTitle = (a) => words.every((w) => lower(a.title).includes(w));
  const results = [...hits.filter(inTitle), ...hits.filter((a) => !inTitle(a))];
  return { results, total: results.length };
}
