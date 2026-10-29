import { Button, Container, Stack, Typography } from '@mui/material';

export default function ErrorPage({ title, message }) {
  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Stack spacing={2} alignItems="flex-start">
        <Typography variant="h4" component="h1">{title}</Typography>
        <Typography color="text.secondary">{message}</Typography>
        <Button href="/" variant="outlined">Back to home</Button>
      </Stack>
    </Container>
  );
}
