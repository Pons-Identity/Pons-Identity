import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { getStoredMode, makeTheme, storeMode } from '../theme.js';
import { useAuth } from '../auth/AuthContext.jsx';

const ThemeModeContext = createContext({ mode: 'system', setMode: () => {} });

export function useThemeMode() {
  return useContext(ThemeModeContext);
}

// Applies the administrator-chosen colors and product name once the session (and its branding) has loaded,
// and the signed-in person's own light/dark choice.
export default function BrandedTheme({ children }) {
  const { session } = useAuth();
  const branding = session.branding;
  const [mode, setModeState] = useState(getStoredMode);
  // "System" follows the operating system, including while the page is open.
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query?.addEventListener) return undefined;
    const onChange = (e) => setSystemDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const theme = useMemo(() => makeTheme(branding, mode), [branding, mode, systemDark]);
  const setMode = (m) => {
    storeMode(m);
    setModeState(m);
  };
  useEffect(() => {
    if (branding?.appName) document.title = branding.appName;
  }, [branding?.appName]);
  return (
    <ThemeModeContext.Provider value={{ mode, setMode }}>
      <ThemeProvider theme={theme}>
        {/* Inside this provider so the page background and text follow the chosen mode, not the operating system's. */}
        <CssBaseline enableColorScheme />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}
