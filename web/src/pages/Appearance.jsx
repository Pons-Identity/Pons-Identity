import { Card, CardContent, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useThemeMode } from '../components/BrandedTheme.jsx';

// Self-service color theme: system, light or dark, saved in this browser.
export default function Appearance() {
  const { mode, setMode } = useThemeMode();

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">Color theme</Typography>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <ToggleButtonGroup exclusive value={mode} onChange={(_, m) => m && setMode(m)} aria-label="Color theme" sx={{ alignSelf: 'flex-start' }}>
              <ToggleButton value="system">System</ToggleButton>
              <ToggleButton value="light">Light</ToggleButton>
              <ToggleButton value="dark">Dark</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="body2" color="text.secondary">Saved in this browser.</Typography>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
