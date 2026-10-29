import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import LdapQueryBuilder, { buildFilter, parseFilter } from './LdapQueryBuilder.jsx';

afterEach(() => vi.unstubAllGlobals());

test('conditions become a filter, escaping special characters', () => {
  expect(buildFilter([{ attr: 'department', op: 'eq', value: 'Underwater Basket-Weaving' }], 'and')).toBe('(department=Underwater Basket-Weaving)');
  expect(buildFilter([
    { attr: 'department', op: 'eq', value: 'R&D (west)' },
    { attr: 'title', op: 'contains', value: 'Prof' },
    { attr: 'mail', op: 'present', value: '' },
    { attr: 'c', op: 'ne', value: 'GB' },
  ], 'and')).toBe('(&(department=R&D \\28west\\29)(title=*Prof*)(mail=*)(!(c=GB)))');
  expect(buildFilter([{ attr: 'a', op: 'eq', value: '1' }, { attr: 'b', op: 'starts', value: '2' }], 'or')).toBe('(|(a=1)(b=2*))');
  expect(buildFilter([{ attr: '', op: 'eq', value: 'x' }, { attr: 'cn', op: 'eq', value: '' }], 'and')).toBe('');
});

test('a simple filter can be read back into conditions; a complex one cannot', () => {
  const back = parseFilter('(&(department=R&D \\28west\\29)(title=*Prof*)(!(c=GB))(mail=*))');
  expect(back.joiner).toBe('and');
  expect(back.rows).toEqual([
    { attr: 'department', op: 'eq', value: 'R&D (west)' },
    { attr: 'title', op: 'contains', value: 'Prof' },
    { attr: 'c', op: 'ne', value: 'GB' },
    { attr: 'mail', op: 'present', value: '' },
  ]);
  expect(parseFilter('(&(a=1)(|(b=2)(c=3)))')).toBeNull();
  expect(parseFilter('(cn=a*b*c)')).toBeNull();
  expect(parseFilter('').rows).toEqual([]);
});

test('the dialog builds a filter, shows the server\'s check, and hands the filter back', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const ok = body.filter.startsWith('(department=Underwater Basket-Weaving)');
    return new Response(JSON.stringify(ok ? { ok: true, matches: 3, sample: [{ username: 'sam' }], attributes: ['department', 'title'] } : { ok: false, error: 'bad' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const onApply = vi.fn();
  render(<LdapQueryBuilder open onClose={() => {}} value="" onApply={onApply} />);
  const row = screen.getByRole('group', { name: 'Condition 1' });
  await userEvent.type(within(row).getByLabelText('Attribute'), 'department');
  await userEvent.type(within(row).getByLabelText('Value'), 'Underwater Basket-Weaving');
  expect(screen.getByLabelText('Query')).toHaveValue('(department=Underwater Basket-Weaving)');
  expect(await screen.findByText(/The syntax is valid\. 3 people match/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Use this query' }));
  expect(onApply).toHaveBeenCalledWith('(department=Underwater Basket-Weaving)');
});

test('the attribute field offers the server\'s attributes, with what each is for, before any value is typed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Write a query first.', attributes: ['mail', 'uid'] }),
    { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<LdapQueryBuilder open onClose={() => {}} value="" onApply={() => {}} />);
  const row = screen.getByRole('group', { name: 'Condition 1' });
  await userEvent.type(within(row).getByLabelText('Attribute'), 'm');
  expect(await screen.findByText('Email address')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /mail/ })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /uid/ })).not.toBeInTheDocument();
});
