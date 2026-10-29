import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from './Notify.jsx';
import CopyTextField from './CopyTextField.jsx';

function Harness({ initial = '' }) {
  const [value, setValue] = useState(initial);
  return <CopyTextField label="Username" value={value} onChange={(e) => setValue(e.target.value)} />;
}

function renderField(initial) {
  return render(<NotifyProvider><Harness initial={initial} /></NotifyProvider>);
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
});

afterEach(() => {
  delete navigator.clipboard;
});

test('the copy button copies the value currently in the field', async () => {
  renderField('bob');
  fireEvent.click(screen.getByRole('button', { name: 'Copy Username' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('bob'));
});

test('an edit that has not been saved is what gets copied', async () => {
  renderField('bob');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob.smith' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy Username' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('bob.smith'));
});

test('the copy button is disabled while the field is empty', () => {
  renderField('');
  expect(screen.getByRole('button', { name: 'Copy Username' })).toBeDisabled();
});
