import { useState } from 'react';
import { Alert, Button, Menu, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { useCan } from '../../auth/permissions.js';
import { ListSearch, useSearchedList } from '../../components/ListSearch.jsx';
import { PROTOCOLS } from './app/appForm.js';

// Every application the IdP serves: SAML service providers and CAS, OpenID Connect and OAuth 2.0 applications.
export default function Sps() {
  const can = useCan();
  const [params] = useSearchParams();
  const [text, setText] = useState(() => params.get('q') || '');
  const { rows, error } = useSearchedList('/admin/applications', text);
  const [anchor, setAnchor] = useState(null);

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography variant="h5" component="h1">Applications</Typography>
        {can('sps.manage') && (
          <>
            <Button variant="contained" startIcon={<AddIcon />} aria-haspopup="menu" onClick={(e) => setAnchor(e.currentTarget)}>New application</Button>
            <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
              {Object.entries(PROTOCOLS).map(([key, p]) => (
                <MenuItem key={key} component={RouterLink} to={p.create} onClick={() => setAnchor(null)}>{p.label}</MenuItem>
              ))}
            </Menu>
          </>
        )}
      </Stack>
      <ListSearch
        label="Search applications"
        value={text}
        onChange={setText}
        helperText="Name, entity ID or client ID, or protocol."
      />
      {error && <Alert severity="error">{error}</Alert>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Entity ID / Client ID</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows && rows.length === 0 && !error && <TableRow><TableCell colSpan={3}><Typography color="text.secondary">No applications match.</Typography></TableCell></TableRow>}
            {(rows || []).map((r) => (
              <TableRow key={`${r.protocol}-${r.id}`} hover component={RouterLink} to={r.to} sx={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
                <TableCell>{r.name}</TableCell>
                <TableCell>{PROTOCOLS[r.protocol].label}</TableCell>
                <TableCell sx={{ wordBreak: 'break-all' }}>{r.identifier}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
