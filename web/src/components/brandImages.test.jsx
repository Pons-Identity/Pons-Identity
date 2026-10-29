import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { brandImages, headerMark, signInImages } from './brandImages.js';
import useFavicon from './favicon.js';

test('session branding gives the addresses; a preview resolves names through the uploaded list', () => {
  expect(brandImages({ logoUrl: '/l', wordmarkUrl: '/w', faviconUrl: '/f', loginBackgroundUrl: '/b' })).toEqual({ logo: '/l', wordmark: '/w', background: '/b', favicon: '/f' });
  const assets = { 'sq.png': '/api/a/1', 'wide.png': '/api/a/2' };
  expect(brandImages({ logoImage: 'sq.png', wordmarkImage: 'wide.png' }, assets)).toMatchObject({ logo: '/api/a/1', wordmark: '/api/a/2' });
  // A legacy logo is used while there is no logo image.
  expect(brandImages({ logo: 'data:image/png;base64,AA' }).logo).toBe('data:image/png;base64,AA');
});

test('the header shows the wordmark in place of the logo when there is one', () => {
  expect(headerMark({ logoUrl: '/l', wordmarkUrl: '/w' })).toBe('/w');
  expect(headerMark({ logoUrl: '/l' })).toBe('/l');
  expect(headerMark({})).toBe('');
});

test('an uploaded favicon is the tab icon', () => {
  const Probe = () => { useFavicon({ faviconUrl: '/api/branding/assets/7' }); return null; };
  render(<Probe />);
  expect(document.getElementById('site-favicon').getAttribute('href')).toBe('/api/branding/assets/7');
  document.getElementById('site-favicon').remove();
});

test('the sign-in page shows its own logo and logotype, and never the header\'s', () => {
  const branding = { logoUrl: '/header-logo', wordmarkUrl: '/header-wordmark', loginLogoUrl: '/sign-in-logo' };
  expect(signInImages(branding)).toMatchObject({ logo: '/sign-in-logo', wordmark: '' });
  // Without a sign-in logo the older logo upload is used, never the header's logo.
  expect(signInImages({ logoUrl: '/header-logo', logo: 'data:image/png;base64,AA' }).logo).toBe('data:image/png;base64,AA');
});
