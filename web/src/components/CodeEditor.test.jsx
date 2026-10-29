import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import CodeEditor from './CodeEditor.jsx';
import { NotifyProvider } from './Notify.jsx';

const editor = (props) => render(<NotifyProvider><CodeEditor label="Script" value={'const a = 1;\nreturn a;'} {...props} /></NotifyProvider>);

test('the editor has File, Edit and Go menus and a footer with the cursor position', async () => {
  const onChange = vi.fn();
  editor({ onChange });
  const toolbar = screen.getByRole('toolbar', { name: 'Script menus' });
  expect(within(toolbar).getByRole('button', { name: 'File' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: 'Go' })).toBeInTheDocument();
  expect(screen.getByText('Ln 1, Col 1')).toBeInTheDocument();
  expect(screen.getByText('2 lines · JavaScript')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Script' })).toHaveTextContent('return a;');
});

test('the File menu offers upload and save as', async () => {
  editor({ onChange: vi.fn() });
  await userEvent.click(screen.getByRole('button', { name: 'File' }));
  expect(screen.getByRole('menuitem', { name: 'Open file…' })).toBeEnabled();
  expect(screen.getByRole('menuitem', { name: 'Save as…' })).toBeEnabled();
});

test('the Edit menu selects all, and Go to line and Find open their panels', async () => {
  editor({ onChange: vi.fn() });
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Select all' }));
  await waitFor(() => expect(screen.getByText('2 lines · JavaScript')).toBeInTheDocument());

  await userEvent.click(screen.getByRole('button', { name: 'Go' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Go to line…' }));
  await waitFor(() => expect(document.querySelector('.cm-goto-line input[name="line"]')).not.toBeNull());
});

test('read-only: paste, undo and upload are disabled, and the text cannot change', async () => {
  const onChange = vi.fn();
  editor({ onChange, disabled: true });
  expect(screen.getByRole('textbox', { name: 'Script' })).toHaveAttribute('contenteditable', 'false');
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('menuitem', { name: 'Paste' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeEnabled();
  await userEvent.keyboard('{Escape}');
  await userEvent.click(screen.getByRole('button', { name: 'File' }));
  expect(screen.getByRole('menuitem', { name: 'Open file…' })).toHaveAttribute('aria-disabled', 'true');
  expect(onChange).not.toHaveBeenCalled();
});
