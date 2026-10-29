import { Navigate, Route, Routes, useLocation, Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useCan } from '../auth/permissions.js';

// A module with one vertical tab per category. A tab appears only for administrators who may use it. `header` sits between the title and the tabs.
export default function TabbedModule({ title, basePath, tabs: allTabs, noAccess, ariaLabel, header }) {
  const can = useCan();
  const { pathname } = useLocation();
  const tabs = allTabs.filter((t) => can(t.permission));
  if (!tabs.length) return <Alert severity="warning">{noAccess}</Alert>;

  const current = tabs.find((t) => pathname.startsWith(`${basePath}/${t.path}`));
  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">{title}</Typography>
      {header}
      <Box sx={{ display: 'flex', gap: 3, height: 'calc(100vh - 180px)', minHeight: 400 }}>
        <Box sx={{ width: 220, flexShrink: 0, overflowY: 'auto', borderRight: 1, borderColor: 'divider' }}>
          <Tabs
            orientation="vertical"
            value={current ? current.path : false}
            aria-label={ariaLabel}
            sx={{ '& .MuiTab-root': { alignItems: 'flex-start', textAlign: 'left', maxWidth: 'none' } }}
          >
            {tabs.map((t) => (
              <Tab key={t.path} value={t.path} label={t.label} component={RouterLink} to={`${basePath}/${t.path}`} />
            ))}
          </Tabs>
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', pr: 1 }}>
          <Routes>
            {tabs.map((t) => <Route key={t.path} path={t.path} element={t.element} />)}
            <Route path="*" element={<Navigate to={`${basePath}/${tabs[0].path}`} replace />} />
          </Routes>
        </Box>
      </Box>
    </Stack>
  );
}
