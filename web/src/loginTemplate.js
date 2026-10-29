// Custom sign-in pages: an HTML template with {{variables}}, plus CSS, both written by an administrator.
// The same code renders the real page and the preview, so what the administrator sees is what people get.

// kind 'input' variables become the form controls; 'value' variables are text or markup filled in by the page.
export const VARIABLES = [
  { name: 'username_input', kind: 'input', required: true, description: 'Username text box (name="username", id="username").' },
  { name: 'password_input', kind: 'input', required: true, description: 'Password box (name="password", id="password").' },
  { name: 'submit_button', kind: 'input', required: true, description: 'The "Sign in" button.' },
  { name: 'error_message', kind: 'value', description: 'Where a failed sign-in explains itself (class "idp-error"). Empty when there is no error.' },
  { name: 'federation_link', kind: 'value', description: '"Sign in with your institution" link. Empty unless federation sign-in is on.' },
  { name: 'recovery_link', kind: 'value', description: '"Forgot your password?" link. Empty unless password recovery is on.' },
  { name: 'app_name', kind: 'value', description: 'The product name from Branding.' },
  { name: 'logo', kind: 'value', description: 'The uploaded logo as an <img>. Empty when there is none.' },
  { name: 'login_message', kind: 'value', description: 'The sign-in message from Branding.' },
  { name: 'primary_color', kind: 'value', description: 'Primary color as text, e.g. #1f5fbf. In CSS, use var(--idp-primary).' },
  { name: 'header_color', kind: 'value', description: 'Header color as text (primary color if unset). In CSS, use var(--idp-header).' },
];

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
        const ok = ATTRS.has(n) || n.startsWith('aria-');
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
export function renderTemplate(template, { branding, federation, federationHref = '/login/federation', recovery = false }) {
  const primary = branding.primaryColor || '#1f5fbf';
  const values = {
    username_input: '<input type="text" id="username" name="username" autocomplete="username" required autofocus data-idp="username">',
    password_input: '<input type="password" id="password" name="password" autocomplete="current-password" required data-idp="password">',
    submit_button: '<button type="submit" data-idp="submit">Sign in</button>',
    error_message: '<div class="idp-error" role="alert" data-idp="error"></div>',
    federation_link: federation ? `<a class="idp-federation" href="${escapeHtml(federationHref)}">Sign in with your institution</a>` : '',
    recovery_link: recovery ? '<a class="idp-recovery" href="/recover">Forgot your password?</a>' : '',
    app_name: escapeHtml(branding.appName),
    logo: branding.logo ? `<img class="idp-logo" src="${escapeHtml(branding.logo)}" alt="${escapeHtml(branding.appName)}">` : '',
    login_message: escapeHtml(branding.loginMessage),
    primary_color: escapeHtml(primary),
    header_color: escapeHtml(branding.headerColor || primary),
  };
  return sanitize(String(template).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, name) => (name in values ? values[name] : '')));
}

/** Wrap administrator CSS so it only applies inside the sign-in page (native CSS nesting under .idp-login). */
export function scopeCss(css) {
  const clean = String(css || '').replace(/@import[^;]*;?/gi, '').replace(/<\/?style[^>]*>/gi, '');
  return clean.trim() ? `.idp-login{${clean}}` : '';
}
