import { expect, test } from 'vitest';
import { missingVariables, renderTemplate, scopeCss, unknownVariables } from './loginTemplate.js';

const branding = { appName: 'Acme <ID>', primaryColor: '#112233', headerColor: '', logo: '', loginMessage: 'Hi' };

test('variables are filled in and text is escaped', () => {
  const html = renderTemplate('<h1>{{app_name}}</h1>{{username_input}}{{password_input}}{{submit_button}}', { branding, federation: false });
  expect(html).toContain('Acme &lt;ID&gt;');
  expect(html).toContain('name="username"');
  expect(html).toContain('name="password"');
});

test('scripts, handlers, frames, forms and javascript: links are removed', () => {
  const html = renderTemplate('<script>alert(1)</script><iframe src="//x"></iframe><form action="//x"><a href="javascript:alert(1)" onclick="x()">go</a></form><img src="https://evil/x.png" onerror="x()">',
    { branding, federation: false });
  expect(html).not.toMatch(/script|iframe|<form|javascript:|onclick|onerror|evil/i);
});

test('federation link appears only when enabled', () => {
  expect(renderTemplate('{{federation_link}}', { branding, federation: false })).toBe('');
  expect(renderTemplate('{{federation_link}}', { branding, federation: true })).toContain('institution');
});

test('reports unknown and missing variables', () => {
  expect(unknownVariables('{{nope}} {{app_name}}')).toEqual(['nope']);
  expect(missingVariables('{{username_input}}')).toEqual(['password_input', 'submit_button']);
});

test('CSS is scoped and cannot import', () => {
  expect(scopeCss('@import url(//x/y.css); a{color:red}')).toBe('.idp-login{ a{color:red}}');
  expect(scopeCss('  ')).toBe('');
});

test('recovery_link is filled only when recovery is on', () => {
  const branding = { appName: 'X' };
  expect(renderTemplate('<p>{{recovery_link}}</p>', { branding, recovery: true })).toContain('href="/recover"');
  expect(renderTemplate('<p>{{recovery_link}}</p>', { branding, recovery: false })).not.toContain('recover');
});

test('the preview asks password managers to leave the sign-in fields alone; the real page does not', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf' };
  const preview = renderTemplate('{{username_input}}{{password_input}}', { branding, preview: true });
  expect(preview).toContain('data-1p-ignore');
  expect(preview).toContain('data-lpignore="true"');
  expect(preview).toContain('autocomplete="off"');
  const live = renderTemplate('{{username_input}}{{password_input}}', { branding });
  expect(live).not.toContain('data-lpignore');
  expect(live).toContain('autocomplete="current-password"');
});
