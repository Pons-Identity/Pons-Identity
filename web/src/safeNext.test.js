import { describe, expect, it } from 'vitest';
import { safeNext } from './safeNext.js';

describe('safeNext', () => {
  it('keeps a path on this site', () => {
    expect(safeNext('/admin/users?x=1')).toBe('/admin/users?x=1');
    expect(safeNext('/oidc/authorize?client_id=a&state=b')).toBe('/oidc/authorize?client_id=a&state=b');
  });

  it('refuses anything that could leave the site', () => {
    for (const bad of ['//evil.test', '/\\evil.test', '/\\/evil.test', '/\t/evil.test', 'https://evil.test', 'javascript:alert(1)', '', null, undefined]) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});
