import { Box, Tab, Tabs } from '@mui/material';
import { Link as RouterLink, useLocation } from 'react-router-dom';

// The Users page's two sections: the people, and the service accounts other software signs in with over SFTP.
export default function UsersTabs() {
  const { pathname } = useLocation();
  const value = pathname.startsWith('/admin/users/service-accounts') ? 'service' : 'people';
  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Tabs value={value} aria-label="Users sections">
        <Tab value="people" label="People" component={RouterLink} to="/admin/users" />
        <Tab value="service" label="Service accounts" component={RouterLink} to="/admin/users/service-accounts" />
      </Tabs>
    </Box>
  );
}
