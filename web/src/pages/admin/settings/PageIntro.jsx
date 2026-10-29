import { Stack, Typography } from '@mui/material';

// Heading and intro text at the top of every settings page, so they look the same everywhere.
export default function PageIntro({ title, children }) {
  return (
    <Stack spacing={1}>
      <Typography variant="h6" component="h2">{title}</Typography>
      {children && <Typography variant="body2" color="text.secondary">{children}</Typography>}
    </Stack>
  );
}
