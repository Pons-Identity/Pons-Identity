import { Button, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import PageIntro from './PageIntro.jsx';
import { useAuth, useProductName } from '../../../auth/AuthContext.jsx';

// The first-run wizard switches itself off once it has run. This is the way back in, for people holding "Re-run the setup wizard".
export default function SetupTab() {
  const productName = useProductName();
  const { session } = useAuth();
  return (
    <Stack spacing={3}>
      <PageIntro title="Setup wizard">
        The setup wizard that ran when {productName} was first started is switched off. You can open it again to change the product name, colors and session limits, or to import from another
        identity provider. It does not touch the administrator account or anyone else's.
      </PageIntro>
      <Typography variant="body2" color="text.secondary">
        It also opens by itself, with a one-time token printed on the server's console, if the database ever has no users in it.
      </Typography>
      <Button variant="contained" component={RouterLink} to="/setup" sx={{ alignSelf: 'flex-start' }} disabled={!session.me}>Open the setup wizard</Button>
    </Stack>
  );
}
