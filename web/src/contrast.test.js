import { expect, test } from 'vitest';
import { bestText, contrastRatio } from './contrast.js';
import { brandPrimary, contrastProblems, makeTheme } from './theme.js';

test('contrast follows the WCAG ratio: black on white is 21:1, and a color on itself is 1:1', () => {
  expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
  expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  expect(contrastRatio('#000000', '#ffffff')).toBe(contrastRatio('#ffffff', '#000000'));
});

test('the button text is whichever of white and black reads better', () => {
  expect(bestText('#1f5fbf')).toBe('#ffffff');
  expect(bestText('#ffff00')).toBe('#000000');
});

test('the default colors pass in both modes', () => {
  expect(contrastProblems({}, 'light')).toEqual([]);
  expect(contrastProblems({}, 'dark')).toEqual([]);
});

test('a primary color that is faint on the page is reported, with its ratio', () => {
  const problems = contrastProblems({ primaryColor: '#ffff00' }, 'light');
  expect(problems.map((p) => p.what)).toContain('Primary color used as text on the page');
  expect(problems.find((p) => p.what.startsWith('Primary color')).ratio).toBeLessThan(4.5);
});

test('the light primary is not used in dark mode, and the dark primary is not used in light mode', () => {
  const branding = { primaryColor: '#1f5fbf', darkPrimaryColor: '#7cb4ff' };
  expect(brandPrimary(branding, 'light')).toBe('#1f5fbf');
  expect(brandPrimary(branding, 'dark')).toBe('#7cb4ff');
  expect(makeTheme(branding, 'dark').palette.primary.main).toBe('#7cb4ff');
  expect(makeTheme(branding, 'light').palette.primary.main).toBe('#1f5fbf');
  // A dark-mode color that is faint on the dark page is reported for dark mode, and does not touch light mode.
  const faint = { primaryColor: '#1f5fbf', darkPrimaryColor: '#202020' };
  expect(contrastProblems(faint, 'dark').length).toBeGreaterThan(0);
  expect(contrastProblems(faint, 'light')).toEqual([]);
});
