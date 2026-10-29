import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import GrouperExport from './GrouperExport.jsx';

vi.mock('../../../auth/permissions.js', () => ({ useCan: () => () => true }));
afterEach(() => vi.unstubAllGlobals());

function mockApi(preview) {
  const urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    urls.push(String(url));
    const path = String(url).replace(/^\/api/, '').split('?')[0];
    const out = {
      '/admin/grouper/export/fields': { subjectFields: { username: 'Username', employee_id: 'Employee / ID number' } },
      '/admin/grouper/export/preview': preview,
      '/admin/grouper/export/push/status': null,
      '/admin/grouper/cutover/history': [],
      '/admin/grouper/loader': { tokenSet: false, tokenCreatedAt: '', lastFetchAt: '', subjectField: 'username', rootStem: 'simpleidp', subjectColumn: 'subject_id', subjectSourceId: '',
        urls: { memberships: 'https://idp/feed/grouper/v1/memberships.csv', groups: 'https://idp/feed/grouper/v1/groups.csv', base: 'https://idp/feed/grouper/v1' }, counts: { groups: 2, memberships: 5, skipped: 1 } },
    }[path];
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return urls;
}

test('download stays disabled until a preview has run, and unresolved people are flagged', async () => {
  const urls = mockApi({
    options: {}, counts: { groups: 3, stems: 2, memberships: 5, nested: 1, composites: 0, privileges: 2, unresolved: 1, warnings: 1 },
    warnings: ['Skipped "ad": it comes from an external directory.'], unresolved: [{ group: 'a:b', username: 'bob', reason: 'x' }], groups: [],
  });
  render(<GrouperExport />);
  expect(screen.getByRole('link', { name: 'Download bundle' })).toHaveAttribute('aria-disabled', 'true');

  await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText(/3 groups in 2 folders, 5 memberships/)).toBeInTheDocument();
  expect(screen.getByText(/bob/)).toBeInTheDocument();
  expect(screen.getByText(/it comes from an external directory/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download bundle' })).toHaveAttribute('href', expect.stringContaining('/api/admin/grouper/export/download?subjectField=username&rootStem=simpleidp'));
  expect(urls.some((u) => u.includes('/preview?subjectField=username'))).toBe(true);
});

test('the connection form appears on the push and cut over tabs only, and the loader tab shows its feed', async () => {
  mockApi({});
  render(<GrouperExport />);
  expect(screen.queryByLabelText('Web services URL')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Push' }));
  expect(screen.getByLabelText('Web services URL')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Cut over' }));
  expect(screen.getByLabelText('Web services URL')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Loader feed' }));
  expect(screen.queryByLabelText('Web services URL')).not.toBeInTheDocument();
  expect(await screen.findByText(/2 groups and 5 memberships are in the feed/)).toBeInTheDocument();
  expect(screen.getByText(/1 person has no username and is left out/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download starter files' })).toHaveAttribute('href', '/api/admin/grouper/loader/bundle');
});
