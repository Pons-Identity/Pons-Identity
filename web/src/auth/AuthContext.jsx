import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CircularProgress, Stack } from '@mui/material';
import { api, setCsrf } from '../api/client.js';
import ErrorPage from '../components/ErrorPage.jsx';

const AuthContext = createContext(null);

// The product's built-in name. Text that cannot wait for the session (or is written before it loads) uses this.
export const DEFAULT_PRODUCT_NAME = 'Pons Identity';

// Loads /api/session once, then keeps the CSRF token and signed-in user available to every page.
// A login regenerates the session (and its CSRF token), so pages that sign in call refresh().
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const s = await api('/session');
    setCsrf(s.csrf);
    setSession(s);
    return s;
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  if (error) return <ErrorPage title={`Can't reach ${DEFAULT_PRODUCT_NAME}`} message={error} />;
  if (!session) {
    return (
      <Stack alignItems="center" sx={{ mt: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }
  return <AuthContext.Provider value={{ session, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

// The name to show in text: the administrator's name when name propagation is on, otherwise the default (see Settings → Branding).
export function useProductName() {
  return useContext(AuthContext)?.session?.branding?.productName || DEFAULT_PRODUCT_NAME;
}
