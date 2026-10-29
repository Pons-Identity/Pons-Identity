import { Stack } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import MigrationPanel from '../../../components/MigrationPanel.jsx';
import { useProductName } from '../../../auth/AuthContext.jsx';

// Imports users, groups and applications from Shibboleth, Okta and Microsoft exports. The same tool is a step of the setup wizard.
export default function MigrationTab() {
  const productName = useProductName();
  return (
    <Stack spacing={3}>
      <PageIntro title="Migration">
        Bring people, groups and applications over from another identity provider. Nothing already here is changed: users, groups and applications that exist are skipped.
        Imported applications start turned off. Switch each one on under Applications once its new {productName} metadata (or client ID) has been given to the application.
      </PageIntro>
      <MigrationPanel base="/admin/migrate" />
    </Stack>
  );
}
