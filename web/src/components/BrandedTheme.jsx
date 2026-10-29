import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { getStoredMode, makeTheme, storeMode } from '../theme.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api/client.js';
import { useNotify } from './Notify.jsx';
import ColorModeDial from './ColorModeDial.jsx';
import useFontStylesheet, { ALL_FONTS } from './useFontStylesheet.js';
import useFavicon from './favicon.js';

const ThemeModeContext = createContext({ mode: 'system', setMode: () => {} });

export function useThemeMode() {
  return useContext(ThemeModeContext);
}

// Applies the administrator-chosen colors and product name once the session (and its branding) has loaded,
// and the person's own color theme. Signed in, the choice is saved to their account and follows them to every device;
// otherwise it is kept in this browser.
export default function BrandedTheme({ children }) {
  const { session } = useAuth();
  const notify = useNotify();
  const branding = session.branding;
  const accountMode = session.me?.color_mode;
  const [mode, setModeState] = useState(() => accountMode || getStoredMode());
  // When the person signs in, their saved choice replaces the one from this browser.
  useEffect(() => {
    if (!accountMode) return;
    setModeState(accountMode);
    storeMode(accountMode);
  }, [accountMode]);
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
  const setMode = async (m) => {
    storeMode(m);
    setModeState(m);
    if (!session.me) return;
    try {
      await api('/account/color-mode', { method: 'POST', body: { color_mode: m } });
    } catch (e) {
      notify(`Your color theme shows here, but could not be saved to your account. ${e.message}`);
    }
  };
  useEffect(() => {
    if (branding?.appName) document.title = branding.appName;
  }, [branding?.appName]);
  // Every installed font is loaded, so a font can be named in the sign-in page's own CSS and HTML, not only the system font.
  useFontStylesheet(ALL_FONTS);
  useFavicon({ faviconUrl: branding?.faviconUrl, logoUrl: branding?.logoUrl });
  return (
    <ThemeModeContext.Provider value={{ mode, setMode }}>
      <ThemeProvider theme={theme}>
        {/* Inside this provider so the page background and text follow the chosen mode, not the operating system's. */}
        <CssBaseline enableColorScheme />
        {children}
        <ColorModeDial mode={mode} onChange={setMode} />
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}
