import { Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useAuth } from '../auth/AuthContext.jsx';
import { useThemeMode } from './BrandedTheme.jsx';

// The System, Light and Dark choice. Signed in, it is saved to the account; otherwise it is saved in this browser.
export default function ColorThemeControl() {
  const { session } = useAuth();
  const { mode, setMode } = useThemeMode();
  return (
    <Stack spacing={2}>
      <ToggleButtonGroup exclusive value={mode} onChange={(_, m) => m && setMode(m)} aria-label="Color theme" sx={{ alignSelf: 'flex-start' }}>
        <ToggleButton value="system">System</ToggleButton>
        <ToggleButton value="light">Light</ToggleButton>
        <ToggleButton value="dark">Dark</ToggleButton>
      </ToggleButtonGroup>
      <Typography variant="body2" color="text.secondary">
        {session.me ? 'Saved to your account, so it applies on every device you sign in from.' : 'Saved in this browser.'}
      </Typography>
    </Stack>
  );
}
