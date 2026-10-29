import { expect, test } from 'vitest';
import { signInBackdrop } from './theme.js';

test('the sign-in backdrop is a light tint in light mode and a deep shade in dark mode, never the primary color itself', () => {
  const primary = '#1f5fbf';
  expect(signInBackdrop(primary, 'light')).toMatch(/^rgb/);
  expect(signInBackdrop(primary, 'light')).not.toBe(primary);
  expect(signInBackdrop(primary, 'dark')).not.toBe(primary);
  expect(signInBackdrop(primary, 'light')).not.toBe(signInBackdrop(primary, 'dark'));
});
