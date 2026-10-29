import { expect, test } from 'vitest';
import { BUILTIN_MARKUP, STARTER_TEMPLATE, sampleMarkup, scopedRuleSelector } from '../loginTemplate.js';
import { matchesFor, ruleAt, selectorAt, specificityOf } from './signInHover.js';

const css = '.login-box label { color: red; }\n& { background: #fff; }\n';

test('the selector under the pointer is the rule the pointer is in, and a declaration is not a selector', () => {
  const at = css.indexOf('label');
  expect(selectorAt(css, at)).toMatchObject({ selector: '.login-box label' });
  expect(selectorAt(css, css.indexOf('color'))).toBeNull();
  expect(selectorAt(css, css.indexOf('background') - 2)).toMatchObject({ selector: '&' });
});

test('selectors are scoped under the sign-in page, with "&" standing for the page itself', () => {
  expect(scopedRuleSelector('.idp-card, &')).toBe('.idp-login .idp-card, .idp-login');
  expect(scopedRuleSelector('& .idp-title')).toBe('.idp-login .idp-title');
  expect(scopedRuleSelector('  ')).toBe('');
});

test('the rule calculator counts the elements a selector matches in the built-in page', () => {
  expect(matchesFor(BUILTIN_MARKUP, '.idp-card').count).toBe(1);
  expect(matchesFor(BUILTIN_MARKUP, '.idp-field').count).toBe(2);
  expect(matchesFor(BUILTIN_MARKUP, '&').count).toBe(1);
  expect(matchesFor(BUILTIN_MARKUP, '.idp-field').elements[0]).toBe('<input id="username" class="idp-field">');
  expect(matchesFor(BUILTIN_MARKUP, '.nothing-here').count).toBe(0);
});

test('pointer and focus states are left out of the match, and reported as such', () => {
  const result = matchesFor(BUILTIN_MARKUP, 'button.idp-submit:hover');
  expect(result.count).toBe(1);
  expect(result.ignored).toEqual([':hover']);
});

test('a custom template is matched as it will be drawn, and an invalid selector says so', () => {
  const markup = sampleMarkup(STARTER_TEMPLATE, { appName: 'Acme' });
  expect(matchesFor(markup, '.login-box label').count).toBe(2);
  expect(matchesFor(markup, 'h1').elements[0]).toBe('<h1>');
  expect(matchesFor(markup, 'h1').count).toBe(1);
  expect(matchesFor(markup, '[[').error).toMatch(/does not understand/);
});

test('specificity is counted the way CSS counts it: ids, then classes and attributes, then elements', () => {
  expect(specificityOf('.idp-login .idp-card')).toEqual([0, 2, 0]);
  expect(specificityOf('#username')).toEqual([1, 0, 0]);
  expect(specificityOf('.idp-login button')).toEqual([0, 1, 1]);
  expect(specificityOf('input[type="text"]:focus')).toEqual([0, 2, 1]);
  // A list counts as its most specific part.
  expect(specificityOf('h1, .idp-login .idp-title')).toEqual([0, 2, 0]);
});

test('the rule a property is in is found from inside its block', () => {
  const css = '.login-box { color: red; }\n';
  expect(ruleAt(css, css.indexOf('color'))).toEqual({ selector: '.login-box' });
  expect(ruleAt(css, css.indexOf('login'))).toBeNull();
});

test('the rule calculator lists elements the way VS Code does, with the specificity of the rule', () => {
  const result = matchesFor(BUILTIN_MARKUP, '.idp-card');
  expect(result.elements).toEqual(['<div class="idp-card">']);
  expect(result.specificity).toEqual([0, 2, 0]);
});
