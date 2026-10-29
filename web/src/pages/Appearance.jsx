import { Card, CardContent, Stack, Typography } from '@mui/material';
import ColorThemeControl from '../components/ColorThemeControl.jsx';

// Self-service color theme: system, light or dark.
export default function Appearance() {
  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">Color theme</Typography>

      <Card variant="outlined">
        <CardContent>
          <ColorThemeControl />
        </CardContent>
      </Card>
    </Stack>
  );
}
