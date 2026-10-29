import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import PassphraseGenerator from './PassphraseGenerator.jsx';
import WORDS from '../passphrase-words.js';

const preview = () => screen.getByRole('status', { name: 'Generated passphrase' });

test('the options change the passphrase, and the one accepted is passed on and the panel closes', async () => {
  const user = userEvent.setup();
  const onUse = vi.fn();
  render(<PassphraseGenerator onUse={onUse} />);
  await user.click(screen.getByRole('button', { name: 'Generate a passphrase' }));
  await waitFor(() => expect(preview()).not.toHaveTextContent('Loading'));

  await user.clear(screen.getByRole('textbox', { name: 'Separator' }));
  await user.type(screen.getByRole('textbox', { name: 'Separator' }), '.');
  await user.clear(screen.getByRole('spinbutton', { name: 'Words' }));
  await user.type(screen.getByRole('spinbutton', { name: 'Words' }), '3');
  await user.click(screen.getByRole('checkbox', { name: 'Capital letters' }));
  await user.click(screen.getByRole('checkbox', { name: 'Include a number' }));
  await waitFor(() => expect(preview().textContent.split('.')).toHaveLength(3));
  const parts = preview().textContent.split('.');
  parts.forEach((p) => expect(WORDS).toContain(p));

  await user.click(screen.getByRole('button', { name: 'Use this passphrase' }));
  expect(onUse).toHaveBeenCalledWith(parts.join('.'));
  expect(screen.queryByRole('status', { name: 'Generated passphrase' })).toBeNull();
});

test('a word count outside 3 to 8 is brought back into range', async () => {
  const user = userEvent.setup();
  render(<PassphraseGenerator onUse={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Generate a passphrase' }));
  const words = screen.getByRole('spinbutton', { name: 'Words' });
  await user.clear(words);
  await user.type(words, '20');
  await user.tab();
  expect(words).toHaveValue(8);
  await user.clear(words);
  await user.type(words, '1');
  await user.tab();
  expect(words).toHaveValue(3);
});
