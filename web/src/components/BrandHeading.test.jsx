import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import BrandHeading from './BrandHeading.jsx';

test('a logo goes to the left of the heading, and the heading stays', () => {
  const { container } = render(<BrandHeading appName="Acme ID" logo="/logo.png" />);
  expect(screen.getByRole('heading', { name: 'Acme ID' })).toBeInTheDocument();
  const img = container.querySelector('img');
  expect(img.getAttribute('src')).toBe('/logo.png');
  // The logo comes before the heading in the header.
  expect(img.compareDocumentPosition(screen.getByRole('heading'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test('a logotype takes the place of the heading, and keeps the name as its text alternative', () => {
  const { container } = render(<BrandHeading appName="Acme ID" logo="/logo.png" wordmark="/wordmark.png" />);
  expect(screen.queryByRole('heading')).toBeNull();
  const wordmark = container.querySelector('img[src="/wordmark.png"]');
  expect(wordmark).toHaveAttribute('alt', 'Acme ID');
  expect(container.querySelector('img[src="/logo.png"]')).toBeInTheDocument();
});

test('with neither image, the heading is the name', () => {
  render(<BrandHeading appName="Acme ID" />);
  expect(screen.getByRole('heading', { name: 'Acme ID' })).toBeInTheDocument();
});
