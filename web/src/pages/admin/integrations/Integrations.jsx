import { useState } from 'react';
import { Navigate, Route, Routes, useLocation, Link as RouterLink } from 'react-router-dom';
import { Box, Button, Stack, Tab, Tabs, Typography } from '@mui/material';
import CommitIcon from '@mui/icons-material/Commit';
import IntegrationList from './IntegrationList.jsx';
import IntegrationEditor from './IntegrationEditor.jsx';
import Variables from './Variables.jsx';
import Functions from './Functions.jsx';
import FunctionEditor from './FunctionEditor.jsx';
import Reference from './Reference.jsx';
import Logging from './Logging.jsx';
import FilesPage from './FilesPage.jsx';
import GitDialog from './GitDialog.jsx';

const TABS = [
  { path: '', label: 'Integrations' },
  { path: 'functions', label: 'Functions' },
  { path: 'variables', label: 'Variables' },
  { path: 'logging', label: 'Logging' },
  { path: 'files', label: 'Files' },
  { path: 'reference', label: 'Reference' },
];

// Scripts that connect the IdP to outside software, and the variables they read. Not a setting: it has its own page.
export default function Integrations() {
  const { pathname } = useLocation();
  const [gitOpen, setGitOpen] = useState(false);
  const [section, item] = pathname.replace(/^\/admin\/integrations\/?/, '').split('/');
  const tab = TABS.find((t) => t.path === section) ? section : '';
  // An integration's or a function's own page has no section tabs.
  const editing = section === 'new' || /^\d+$/.test(section) || (section === 'functions' && Boolean(item));

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5" component="h1">Integrations</Typography>
        {!editing && <Button variant="outlined" startIcon={<CommitIcon />} onClick={() => setGitOpen(true)}>Git</Button>}
      </Stack>
      <GitDialog open={gitOpen} onClose={() => setGitOpen(false)} />
      {!editing && (
        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={tab} aria-label="Integrations sections">
            {TABS.map((t) => <Tab key={t.path} value={t.path} label={t.label} component={RouterLink} to={`/admin/integrations/${t.path}`} />)}
          </Tabs>
        </Box>
      )}
      <Routes>
        <Route index element={<IntegrationList />} />
        <Route path="functions" element={<Functions />} />
        <Route path="functions/new" element={<FunctionEditor />} />
        <Route path="functions/:name" element={<FunctionEditor />} />
        <Route path="variables" element={<Variables />} />
        <Route path="logging" element={<Logging />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="reference" element={<Reference />} />
        <Route path="new" element={<IntegrationEditor />} />
        <Route path=":id" element={<IntegrationEditor />} />
        <Route path="*" element={<Navigate to="/admin/integrations" replace />} />
      </Routes>
    </Stack>
  );
}
