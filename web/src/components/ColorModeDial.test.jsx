import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ColorModeDial from './ColorModeDial.jsx';

test('the speed dial shows the current choice, and choosing another one reports it', () => {
  const onChange = vi.fn();
  render(<ColorModeDial mode="dark" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Color theme' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Light' }));
  expect(onChange).toHaveBeenCalledWith('light');
});

test('the current choice is marked on its action', () => {
  render(<ColorModeDial mode="system" onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Color theme' }));
  expect(screen.getByRole('menuitem', { name: 'System (current)' })).toHaveAttribute('aria-pressed', 'true');
});
