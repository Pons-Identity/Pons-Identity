// Thin fetch wrapper for the IdP's /api routes.

let csrfToken = '';

export function setCsrf(token) {
  csrfToken = token || '';
}

export class ApiError extends Error {
  constructor(status, data) {
    const message = data?.error || (data?.errors || []).join(' ') || `Request failed (${status})`;
    super(message);
    this.status = status;
    this.data = data;
  }
}

// A Blob (such as a File) is sent as the raw request body with its own type; anything else is sent as JSON.
export async function api(path, { method = 'GET', body, withCsrf = false, headers: extra } = {}) {
  const headers = { accept: 'application/json', ...extra };
  if (body instanceof Blob) headers['content-type'] = body.type || 'application/octet-stream';
  else if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' || withCsrf) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  // The setup wizard answers 401 to a wrong setup token; that is for the wizard to show, not a reason to sign in.
  if (res.status === 401 && !window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/setup')) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new ApiError(res.status, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
