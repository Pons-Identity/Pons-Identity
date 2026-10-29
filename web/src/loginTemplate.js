// Custom sign-in pages: an HTML template with {{variables}}, plus CSS, both written by an administrator.
// The same code renders the real page and the preview, so what the administrator sees is what people get.

// kind 'input' variables become the form controls; 'value' variables are text or markup filled in by the page.
import { signInImages } from './components/brandImages.js';

export const VARIABLES = [
  { name: 'username_input', kind: 'input', required: true, description: 'Username text box (name="username", id="username").' },
  { name: 'password_input', kind: 'input', required: true, description: 'Password box (name="password", id="password").' },
  { name: 'submit_button', kind: 'input', required: true, description: 'The "Sign in" button.' },
  { name: 'error_message', kind: 'value', description: 'Where a failed sign-in explains itself (class "idp-error"). Empty when there is no error.' },
  { name: 'federation_link', kind: 'value', description: '"Sign in with your institution" link. Empty unless federation sign-in is on.' },
  { name: 'recovery_link', kind: 'value', description: '"Forgot your password?" link. Empty unless password recovery is on.' },
  { name: 'app_name', kind: 'value', description: 'The product name from Branding.' },
  { name: 'logo', kind: 'value', description: 'The square logo as an <img>. Empty when there is none.' },
  { name: 'wordmark', kind: 'value', description: 'The wordmark (a wide text logo) as an <img>. Empty when there is none.' },
  { name: 'login_message', kind: 'value', description: 'The sign-in message from Branding.' },
  { name: 'primary_color', kind: 'value', description: 'Primary color as text, e.g. #1f5fbf. In CSS, use var(--idp-primary).' },
  { name: 'header_color', kind: 'value', description: 'Header color as text (primary color if unset). In CSS, use var(--idp-header).' },
];

// Attributes that ask password managers (1Password, LastPass, Bitwarden and others that honour them) not to offer to fill or save
// the sign-in fields. Only the preview carries them: the real page keeps autofill, which users rely on. Browsers' own autofill has no
// page-level opt-out that all of them respect, so it can still appear.
export const PREVIEW_IGNORE = { 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other', 'autocomplete': 'off' };
const PREVIEW_IGNORE_HTML = 'data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" autocomplete="off"';

export const MAX_TEMPLATE = 20000;
export const MAX_CSS = 50000;

export const STARTER_TEMPLATE = `<div class="login-box">
  {{logo}}
  <h1>Welcome to {{app_name}}</h1>
  <p>{{login_message}}</p>
  {{error_message}}
  <label for="username">Username</label>
  {{username_input}}
  <label for="password">Password</label>
  {{password_input}}
  {{submit_button}}
  {{recovery_link}}
  {{federation_link}}
</div>`;

export const STARTER_CSS = `/* Applies to the sign-in page, built-in or custom. Write rules as usual; they only affect this page.
   Variables: var(--idp-primary), var(--idp-header). Use "&" for the page background itself. */
& {
  background: #f1f4f9;
}
.login-box {
  max-width: 24rem;
  margin: 4rem auto;
  padding: 2rem;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}
.login-box label { display: block; margin: 1rem 0 0.25rem; font-size: 0.875rem; }
.login-box input { width: 100%; box-sizing: border-box; padding: 0.6rem; font-size: 1rem; }
.login-box button { margin-top: 1.5rem; width: 100%; padding: 0.7rem; border: 0; border-radius: 6px; background: var(--idp-primary); color: #fff; font-size: 1rem; }
.idp-error { color: #b3261e; margin: 0.5rem 0; }
`;

// The classes the built-in page draws its parts with, and what each is for. Shown to administrators beside the CSS editor.
// A meta class says which mode the page is in. It is on the page's content, so write it before the card: .idp-dark .idp-card.
export const BUILTIN_CLASSES = [
  { name: 'idp-login', what: 'The whole sign-in page. Style the page background with "&", as in the example CSS.' },
  { name: 'idp-light', meta: true, what: 'Set on the page content while the page is in light mode. Style the page only in light mode with .idp-light, such as .idp-light .idp-card.' },
  { name: 'idp-dark', meta: true, what: 'Set on the page content while the page is in dark mode, whether the person chose it or the administrator previews it. Style the page only in dark mode with .idp-dark, such as .idp-dark .idp-card.' },
  { name: 'idp-bg', what: 'The background picture behind the card (built-in page only). Its blur, brightness and contrast are set under Background.' },
  { name: 'idp-card', what: 'The box that holds the sign-in form.' },
  { name: 'idp-logo', what: 'The logo image.' },
  { name: 'idp-title', what: 'The "Sign in" heading.' },
  { name: 'idp-message', what: 'The sign-in message from Branding.' },
  { name: 'idp-field', what: 'The username and password boxes.' },
  { name: 'idp-submit', what: 'The "Sign in" button.' },
  { name: 'idp-error', what: 'The message shown after a failed sign-in.' },
  { name: 'idp-recovery', what: 'The "Forgot your password?" link.' },
  { name: 'idp-federation', what: 'The "Sign in with your institution" link and button.' },
  { name: 'idp-notice', what: 'The text the administrator adds to the sign-in page, under the card (or in the footer, with the class idp-footer).' },
  { name: 'idp-footer', what: 'The footer bar with the text the administrator adds, when it is set to sit in the footer.' },
];

// The built-in page's structure, for matching CSS selectors in the editor (the real page is drawn by LoginView).
export const BUILTIN_MARKUP = `<div class="idp-bg"></div><div class="idp-card">
  <img class="idp-logo" alt="">
  <h1 class="idp-title">Sign in</h1>
  <p class="idp-message"></p>
  <label for="username">Username</label><input id="username" name="username" class="idp-field">
  <label for="password">Password</label><input id="password" name="password" type="password" class="idp-field">
  <button type="submit" class="idp-submit">Sign in</button>
  <a class="idp-recovery" href="/recover">Forgot your password?</a>
  <a class="idp-federation" href="/login/federation">Sign in with your institution</a>
</div>`;

/** Replaces the file names the page refers to with the addresses of the uploaded images: the names in `assets` (name to address). */
export function resolveImageNames(html, assets = {}) {
  return String(html).replace(/(\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (m, pre, q, name) => (assets[name] ? `${pre}${q}${assets[name]}${q}` : m));
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Template variable names used in `template` that this page does not define. */
export function unknownVariables(template) {
  const known = new Set(VARIABLES.map((v) => v.name));
  return [...new Set([...String(template).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))].filter((n) => !known.has(n));
}

/** Required input variables the template leaves out. */
export function missingVariables(template) {
  return VARIABLES.filter((v) => v.required && !new RegExp(`\\{\\{\\s*${v.name}\\s*\\}\\}`).test(template)).map((v) => v.name);
}

const SAFE_URL = /^(https?:|mailto:|\/(?!\/)|#|\.{0,2}\/)/i;
const SAFE_IMG = /^(data:image\/(png|jpeg|gif|webp|svg\+xml);base64,|\/(?!\/))/i;
const TAGS = new Set(['div', 'span', 'p', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'br', 'hr', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'u', 'small',
  'label', 'input', 'button', 'section', 'header', 'footer', 'main', 'nav', 'article', 'aside', 'blockquote', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'td', 'th']);
const ATTRS = new Set(['class', 'id', 'style', 'href', 'src', 'alt', 'title', 'for', 'name', 'type', 'placeholder', 'autocomplete', 'required', 'autofocus',
  'disabled', 'value', 'maxlength', 'target', 'rel', 'role', 'colspan', 'rowspan', 'width', 'height', 'data-idp']);

/** Keep only allowed tags and attributes: no scripts, event handlers, forms, frames or javascript: links. */
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      const tag = el.tagName.toLowerCase();
      if (!TAGS.has(tag)) {
        // Unknown wrapper: drop it but keep harmless text/children; drop executable or embedded content entirely.
        if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'link', 'meta', 'base', 'template', 'noscript'].includes(tag)) el.remove();
        else { walk(el); el.replaceWith(...el.childNodes); }
        continue;
      }
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        const ok = ATTRS.has(n) || n.startsWith('aria-') || n.startsWith('data-');
        if (!ok || (n === 'href' && !SAFE_URL.test(a.value.trim())) || (n === 'src' && !SAFE_IMG.test(a.value.trim()))
          || (n === 'style' && /url\(|expression|@import/i.test(a.value))
          || (n === 'type' && tag === 'input' && !['text', 'password', 'email', 'submit'].includes(a.value.toLowerCase()))
          || (n === 'type' && tag === 'button' && a.value.toLowerCase() !== 'submit')) el.removeAttribute(a.name);
      }
      if (tag === 'a' && el.getAttribute('target') === '_blank') el.setAttribute('rel', 'noopener noreferrer');
      walk(el);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/** Fill the variables in and sanitize. Pass the result to dangerouslySetInnerHTML inside a <form>. */
export function renderTemplate(template, { branding, federation, federationHref = '/login/federation', recovery = false, assets = {}, preview = false }) {
  const primary = branding.primaryColor || '#1f5fbf';
  const { logo, wordmark } = signInImages(branding, assets);
  const values = {
    username_input: `<input type="text" id="username" name="username" ${preview ? PREVIEW_IGNORE_HTML : 'autocomplete="username"'} required autofocus data-idp="username">`,
    password_input: `<input type="password" id="password" name="password" ${preview ? PREVIEW_IGNORE_HTML : 'autocomplete="current-password"'} required data-idp="password">`,
    submit_button: '<button type="submit" data-idp="submit">Sign in</button>',
    error_message: '<div class="idp-error" role="alert" data-idp="error"></div>',
    federation_link: federation ? `<a class="idp-federation" href="${escapeHtml(federationHref)}">Sign in with your institution</a>` : '',
    recovery_link: recovery ? '<a class="idp-recovery" href="/recover">Forgot your password?</a>' : '',
    app_name: escapeHtml(branding.appName),
    logo: logo ? `<img class="idp-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(branding.appName)}">` : '',
    wordmark: wordmark ? `<img class="idp-wordmark" src="${escapeHtml(wordmark)}" alt="${escapeHtml(branding.appName)}">` : '',
    login_message: escapeHtml(branding.loginMessage),
    primary_color: escapeHtml(primary),
    header_color: escapeHtml(branding.headerColor || primary),
  };
  return sanitize(resolveImageNames(String(template), assets).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, name) => (name in values ? values[name] : '')));
}

/** The page's markup as it would be drawn, for matching CSS selectors: the administrator's template, or the built-in page. */
export function sampleMarkup(template, branding) {
  return template ? renderTemplate(template, { branding, federation: true, recovery: true }) : BUILTIN_MARKUP;
}

/**
 * A rule's selector as the page applies it: scoped under .idp-login, with "&" standing for the page itself, as the native CSS nesting
 * in scopeCss does. Empty for an empty selector.
 */
export function scopedRuleSelector(selector) {
  return String(selector).split(',').map((p) => p.trim()).filter(Boolean)
    .map((p) => (p.includes('&') ? p.replaceAll('&', '.idp-login') : `.idp-login ${p}`)).join(', ');
}

// The built-in look of the sign-in card. It is built in, not shown in the CSS editor, and comes before the administrator's CSS with
// the same specificity, so any rule the administrator writes for the card overrides it. Where the browser asks for reduced
// transparency, the card is solid and loses its blur.
export const DEFAULT_CARD_CSS = `.idp-login .idp-card {
  border-radius: 16px;
  background-color: rgba(255,255,255,0.9);
  border: 2px #f0f0f0 solid;
  border-left: 2px #fcfcfc solid;
  backdrop-filter: blur(2px);
}
@media (prefers-reduced-transparency: reduce) {
  .idp-login .idp-card {
    background-color: #ffffff;
    backdrop-filter: none;
  }
}
.idp-dark .idp-card {
  background-color: rgba(33,33,33,0.9);
  border: 2px #3a3a3a solid;
  border-left: 2px #424242 solid;
}
@media (prefers-reduced-transparency: reduce) {
  .idp-dark .idp-card {
    background-color: #212121;
  }
}
`;

/** Wrap administrator CSS so it only applies inside the sign-in page (native CSS nesting under .idp-login). */
export function scopeCss(css, assets = {}) {
  const named = String(css || '').replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, name) => (assets[name] ? `url(${q}${assets[name]}${q})` : m));
  const clean = named.replace(/@import[^;]*;?/gi, '').replace(/<\/?style[^>]*>/gi, '');
  return clean.trim() ? `.idp-login{${clean}}` : '';
}
