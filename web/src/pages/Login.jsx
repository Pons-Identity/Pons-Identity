import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import LoginView from '../components/LoginView.jsx';
import { safeNext } from '../safeNext.js';

// Asked for only when an administrator turned the device-location risk signal on. It can only raise the risk of a sign-in, so
// declining, or a slow answer, simply means that signal stays quiet.
const browserLocation = () => new Promise((resolve) => {
  if (!navigator.geolocation) return resolve(undefined);
  navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), () => resolve(undefined), { timeout: 4000, maximumAge: 600000 });
});

export default function Login() {
  const { session, refresh } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [error, setError] = useState(location.state?.error || '');
  const [busy, setBusy] = useState(false);
  // The administrator's template and CSS are not part of the public settings; this page fetches them separately.
  const custom = session.branding.loginCustom;
  const [page, setPage] = useState(custom ? null : { template: '', css: '' });

  useEffect(() => {
    if (!custom) return;
    api('/login-page', { withCsrf: true }).then(setPage).catch(() => setPage({ template: '', css: '' }));
  }, [custom]);

  // Signed in and no protocol redirect pending: go to the launcher.
  if (session.me && !params.has('next')) return <Navigate to="/" replace />;
  if (!page) return null;

  async function submit({ username, password }) {
    setBusy(true);
    setError('');
    try {
      const device_geo = session.config?.deviceGeolocation ? await browserLocation() : undefined;
      const r = await api('/login', { method: 'POST', body: { username, password, next, device_geo } });
      if (r.mfa === 'totp') return navigate('/login/mfa');
      if (r.mfa === 'duo') return navigate('/login/duo');
      await refresh();
      window.location.assign(r.next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginView branding={session.branding} template={page.template} css={page.css} federation={Boolean(session.config?.federationLogin)} recovery={Boolean(session.config?.passwordRecovery)}
      federationHref={`/login/federation${params.has('next') ? `?next=${encodeURIComponent(next)}` : ''}`}
      error={error} busy={busy} onSubmit={submit} />
  );
}
