import { createTheme, darken, lighten } from '@mui/material/styles';
import { MIN_CONTRAST, bestText, contrastRatio } from './contrast.js';

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
const DEFAULT_DARK_PRIMARY = '#7cb4ff';
const SYSTEM_FONTS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** The CSS font stack for the system font: an installed family first (its faces come from useFontStylesheet), then the defaults. */
export const fontStack = (family) => (family ? `"${family}", ${SYSTEM_FONTS}` : SYSTEM_FONTS);

/** 'light' or 'dark' as the person sees it: 'system' follows the operating system. */
export function resolvedMode(mode = 'system') {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
}

/** The primary color for a mode ('light' or 'dark'): the dark-mode one in dark mode, the light one otherwise. */
export function brandPrimary(branding = {}, mode = 'light') {
  return mode === 'dark' ? (branding.darkPrimaryColor || DEFAULT_DARK_PRIMARY) : (branding.primaryColor || DEFAULT_PRIMARY);
}

/**
 * The sign-in page's backdrop when it has no picture: a light tint of the primary color in light mode, a deep shade of it in dark
 * mode. Related to the theme color, but not the same as it.
 */
export function signInBackdrop(primary, mode = 'light') {
  return mode === 'dark' ? darken(primary, 0.7) : lighten(primary, 0.85);
}

// Administrators set the colors and the system font under Admin > Settings > Branding. The primary color is used in light mode
// and the dark-mode primary only in dark mode. The button's text is whichever of white and black reads better on it.
export function makeTheme(branding = {}, mode = 'system') {
  const resolved = resolvedMode(mode);
  const primary = brandPrimary(branding, resolved);
  return createTheme({
    palette: {
      mode: resolved,
      primary: { main: primary, contrastText: bestText(primary) },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: fontStack(branding.fontFamily),
    },
    components: branding.headerColor ? {
      MuiAppBar: { styleOverrides: { colorPrimary: { backgroundColor: branding.headerColor } } },
    } : {},
  });
}

/**
 * The places where the primary color is too faint to read at the 4.5:1 level: the button's text on the button, on hover, and
 * the primary color as text on the page. Returns the failing ones with their ratios; empty when all pass.
 */
export function contrastProblems(branding, mode) {
  const { primary, background } = makeTheme(branding, mode).palette;
  return [
    { what: 'Button text on the button', ratio: contrastRatio(primary.contrastText, primary.main) },
    { what: 'Button text on hover', ratio: contrastRatio(primary.contrastText, primary.dark) },
    { what: 'Primary color used as text on the page', ratio: contrastRatio(primary.main, background.default) },
  ].filter((c) => c.ratio < MIN_CONTRAST);
}

export const theme = makeTheme();
