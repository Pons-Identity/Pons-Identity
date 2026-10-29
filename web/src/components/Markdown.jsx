import { Fragment } from 'react';

// A small Markdown reader for text an administrator writes on the sign-in page: headings, paragraphs, lists, **bold**, *italic*,
// `code` and [links](address). It builds React elements only, so no HTML in the text is ever drawn as HTML. A link goes only to
// a web, mail, same-site or page address; any other address is shown as plain text.

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

/** Splits Markdown text into blocks: { type: 'heading', level, text }, { type: 'paragraph', text }, { type: 'list', ordered, items }. */
export function parseMarkdown(source) {
  const blocks = [];
  let paragraph = null;
  let list = null;
  const endRuns = () => { paragraph = null; list = null; };
  for (const raw of String(source || '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const item = /^([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (!line) {
      endRuns();
    } else if (heading) {
      endRuns();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
    } else if (item) {
      const ordered = /\d/.test(item[1]);
      if (!list || list.ordered !== ordered) {
        paragraph = null;
        list = { type: 'list', ordered, items: [] };
        blocks.push(list);
      }
      list.items.push(item[2]);
    } else if (paragraph) {
      paragraph.text += ` ${line}`;
    } else {
      list = null;
      paragraph = { type: 'paragraph', text: line };
      blocks.push(paragraph);
    }
  }
  return blocks;
}

// Code, bold, italic and links, in the order they are looked for.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/;

/** The inline parts of a line of text, as React elements. */
export function renderInline(text) {
  return String(text).split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link && SAFE_HREF.test(link[2])) {
      const external = /^https?:/i.test(link[2]);
      return <a key={i} href={link[2]} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{link[1]}</a>;
    }
    if (link) return <Fragment key={i}>{link[1]}</Fragment>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** Markdown text as React elements, for the sign-in page's text. */
export default function Markdown({ text }) {
  return parseMarkdown(text).map((block, i) => {
    if (block.type === 'heading') {
      const Tag = `h${block.level + 2}`; // The page has one h1 (the sign-in heading), so text headings start at h3.
      return <Tag key={i}>{renderInline(block.text)}</Tag>;
    }
    if (block.type === 'list') {
      const Tag = block.ordered ? 'ol' : 'ul';
      return <Tag key={i}>{block.items.map((t, j) => <li key={j}>{renderInline(t)}</li>)}</Tag>;
    }
    return <p key={i}>{renderInline(block.text)}</p>;
  });
}
