import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import PasswordStrength, { PasswordGuidance } from './PasswordStrength.jsx';

test('a common password is Very weak and says what is required', async () => {
  render(<PasswordStrength password="password" minScore={3} />);
  expect(await screen.findByText('Very weak')).toBeInTheDocument();
  expect(screen.getByText(/good or better is required/i)).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Password strength' })).toHaveAttribute('aria-valuetext', 'Very weak');
});

test('a long unusual passphrase is Strong and nothing is demanded', async () => {
  render(<PasswordStrength password="tangerine-orbit-velvet-quarry" minScore={3} />);
  expect(await screen.findByText('Strong')).toBeInTheDocument();
  expect(screen.queryByText(/is required/i)).toBeNull();
});

test('words from the account make a password weaker, and an empty password shows nothing', async () => {
  const { container, rerender } = render(<PasswordStrength password="" />);
  expect(container).toBeEmptyDOMElement();
  rerender(<PasswordStrength password="hayworth" userInputs={['hayworth']} />);
  expect(await screen.findByText(/weak/i)).toBeInTheDocument();
});

test('the rules are listed, and the bar appears only when strength checking is on', async () => {
  const rules = { min_length: 12, requirements: ['At least 12 characters', 'Include a digit'], strength: null };
  const { rerender } = render(<PasswordGuidance rules={rules} password="abc" />);
  expect(screen.getByText('Include a digit')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).toBeNull();
  rerender(<PasswordGuidance rules={{ ...rules, strength: { min_score: 2 } }} password="abc" />);
  expect(await screen.findByRole('progressbar')).toBeInTheDocument();
});
