import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import RepeaterRows from './RepeaterRows.jsx';

function Harness({ initial }) {
  const [rows, setRows] = useState(initial);
  return (
    <>
      <RepeaterRows rows={rows} onChange={setRows} fields={[{ key: 'url', label: 'ACS URL' }]}
        emptyRow={{ url: '' }} addLabel="Add ACS URL" />
      <output data-testid="count">{rows.length}</output>
    </>
  );
}

test('adds and removes rows', () => {
  render(<Harness initial={[{ url: 'https://sp.test/acs' }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add ACS URL' }));
  expect(screen.getByTestId('count')).toHaveTextContent('2');
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove row' })[0]);
  expect(screen.getByTestId('count')).toHaveTextContent('1');
  expect(screen.getByLabelText('ACS URL')).toHaveValue('');
});
