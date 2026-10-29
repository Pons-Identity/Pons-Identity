import { Box, Stack, Typography, useTheme } from '@mui/material';

// Named colors for log and output lines, stepped for the light and dark surfaces so each reads on either.
const NAMED = {
  default: { light: 'inherit', dark: 'inherit' },
  grey: { light: '#6b7280', dark: '#9ca3af' },
  red: { light: '#c62828', dark: '#f48fb1' },
  orange: { light: '#b45309', dark: '#ffb74d' },
  yellow: { light: '#8a6d00', dark: '#ffd54f' },
  green: { light: '#2e7d32', dark: '#81c784' },
  blue: { light: '#1565c0', dark: '#64b5f6' },
  purple: { light: '#7b1fa2', dark: '#ce93d8' },
  cyan: { light: '#00838f', dark: '#4dd0e1' },
};
export const COLOR_NAMES = Object.keys(NAMED);

const colorIn = (mode, color) => (NAMED[color] ? NAMED[color][mode] : /^#[0-9a-f]{3,6}$/i.test(color || '') ? color : 'inherit');

/** The CSS color for a line's color (a name or a hex value) on the current theme. */
export function useLineColor() {
  const mode = useTheme().palette.mode;
  return (color) => colorIn(mode, color);
}

/** A line's color on a white page, whatever the theme. */
export const lightLineColor = (color) => colorIn('light', color);

export const LEVEL_LABEL = { debug: 'DEBUG', normal: 'INFO', warning: 'WARN', error: 'ERROR' };

/**
 * Lines as a console would show them. A line is { text, color, level?, time?, prefix? }. `showLevel` marks the level of each
 * (log lines) and `showTime` shows its time of day.
 */
export default function LogLines({ lines, label, showLevel = false, showTime = false, empty = 'Nothing was written.' }) {
  const colorOf = useLineColor();
  if (!lines.length) return <Typography variant="body2" color="text.secondary">{empty}</Typography>;
  return (
    <Box component="ol" aria-label={label} sx={{ m: 0, p: 1.5, listStyle: 'none', bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', fontFamily: 'monospace', fontSize: 13 }}>
      {lines.map((l, i) => (
        <Stack key={l.id ?? i} component="li" direction="row" spacing={1} sx={{ color: colorOf(l.color), alignItems: 'baseline' }}>
          {showTime && l.time && <Box component="time" dateTime={l.time} sx={{ opacity: 0.7, flexShrink: 0 }}>{new Date(l.time).toLocaleTimeString([], { hour12: false })}</Box>}
          {showLevel && <Box component="span" sx={{ width: '5.5ch', flexShrink: 0, fontWeight: 600 }}>{LEVEL_LABEL[l.level] || l.level}</Box>}
          {l.prefix && <Box component="span" sx={{ opacity: 0.7, flexShrink: 0 }}>{l.prefix}</Box>}
          <Box component="span" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 }}>{l.text}</Box>
        </Stack>
      ))}
    </Box>
  );
}
