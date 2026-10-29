import { expect, test, vi } from 'vitest';
import { api, setCsrf } from './client.js';

test('writes send the CSRF token and surface validation errors', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errors: ['Name is required.'] }),
    { status: 400, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  setCsrf('tok123');

  await expect(api('/admin/groups', { method: 'POST', body: {} })).rejects.toMatchObject({
    status: 400,
    message: 'Name is required.',
  });
  const [url, opts] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/admin/groups');
  expect(opts.headers['x-csrf-token']).toBe('tok123');
  vi.unstubAllGlobals();
});

test('reads do not send a CSRF token', async () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  setCsrf('tok123');

  expect(await api('/session')).toEqual({ ok: true });
  const [, opts] = fetchMock.mock.calls[0];
  expect(opts.headers['x-csrf-token']).toBeUndefined();
  vi.unstubAllGlobals();
});
