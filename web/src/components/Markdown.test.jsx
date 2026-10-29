import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import Markdown, { parseMarkdown } from './Markdown.jsx';

test('blocks: headings, paragraphs (joined across lines), and lists', () => {
  expect(parseMarkdown('# Help\n\nCall the desk\non extension 4.\n\n- one\n- two\n\n1. first')).toEqual([
    { type: 'heading', level: 1, text: 'Help' },
    { type: 'paragraph', text: 'Call the desk on extension 4.' },
    { type: 'list', ordered: false, items: ['one', 'two'] },
    { type: 'list', ordered: true, items: ['first'] },
  ]);
});

test('links, bold, italic and code render as elements; a link goes only to a safe address', () => {
  const { container } = render(<Markdown text={'See [the guide](https://example.org/help) or [mail](mailto:help@example.org) and **bold**, *italic*, `code`.'} />);
  const link = container.querySelector('a[href="https://example.org/help"]');
  expect(link).toHaveTextContent('the guide');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(container.querySelector('a[href^="mailto:"]')).toBeInTheDocument();
  expect(container.querySelector('strong')).toHaveTextContent('bold');
  expect(container.querySelector('em')).toHaveTextContent('italic');
  expect(container.querySelector('code')).toHaveTextContent('code');
});

test('an unsafe link shows its text only, and HTML in the text is shown as text', () => {
  const { container } = render(<Markdown text={'[click](javascript:alert(1)) <img src=x onerror=alert(1)>'} />);
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('click');
  expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
});
