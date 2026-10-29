import { createTheme } from '@mui/material/styles';

const systemPrefersDark = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;

// Each person picks 'light', 'dark' or 'system' (follow the operating system) on their profile page.
const MODE_KEY = 'theme-mode';
export function getStoredMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return ['light', 'dark', 'system'].includes(m) ? m : 'system';
  } catch {
    return 'system';
  }
}
export function storeMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch { /* storage unavailable; the choice lasts for this page view */ }
}

const DEFAULT_PRIMARY = '#1f5fbf';

// Administrators set the colors under Admin > Settings > Branding.
export function makeTheme(branding = {}, mode = 'system') {
  const primary = branding.primaryColor || DEFAULT_PRIMARY;
  return createTheme({
    palette: {
      mode: mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode,
      primary: { main: primary },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    },
    components: branding.headerColor ? {
      MuiAppBar: { styleOverrides: { colorPrimary: { backgroundColor: branding.headerColor } } },
    } : {},
  });
}

export const theme = makeTheme();
