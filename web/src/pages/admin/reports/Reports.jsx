import { useEffect, useState } from 'react';
import { Alert, Button, Chip, Link, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { Link as RouterLink, Route, Routes } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import ReportEditor from './ReportEditor.jsx';
import BuilderEditor from './BuilderEditor.jsx';

const BASE = '/admin/reports';

function ReportTable({ label, rows, to, empty }) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small" aria-label={label}>
        <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Description</TableCell></TableRow></TableHead>
        <TableBody>
          {rows.length === 0 && <TableRow><TableCell colSpan={2}><Typography color="text.secondary">{empty}</Typography></TableCell></TableRow>}
          {rows.map((r) => (
            <TableRow key={r.key || r.id} hover>
              <TableCell>
                <Link component={RouterLink} to={to(r)}>{r.name}</Link>
                {r.runnable === false && <Chip size="small" label={`Needs ${r.requires.join(', ')}`} sx={{ ml: 1 }} />}
                {r.kind === 'builder' && <Chip size="small" variant="outlined" label="Builder" sx={{ ml: 1 }} />}
              </TableCell>
              <TableCell>{r.description}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ReportList({ meta }) {
  const can = useCan();
  return (
    <Stack spacing={3}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
          A report reads data from the IdP and shows it as a table you can download. Run a pre-built one, or write your own in JavaScript.
          Reports run with your own access, so they show only what you could already see, and they never change anything.
        </Typography>
        {can('reports.manage') && (
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" component={RouterLink} to={`${BASE}/new/builder`}>Build a report</Button>
            <Button variant="contained" startIcon={<AddIcon />} component={RouterLink} to={`${BASE}/new`}>New report</Button>
          </Stack>
        )}
      </Stack>
      <Typography variant="h6" component="h2">Pre-built reports</Typography>
      <ReportTable label="Pre-built reports" rows={meta.builtin} to={(r) => `${BASE}/builtin/${r.key}`} empty="None." />
      <Typography variant="h6" component="h2">Custom reports</Typography>
      <ReportTable label="Custom reports" rows={meta.reports} to={(r) => `${BASE}/${r.id}`} empty="No custom reports yet." />
    </Stack>
  );
}

// Runs and writes reports. Not a setting: it has its own page.
export default function Reports() {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api(BASE).then((m) => { if (live) setMeta(m); }, (err) => { if (live) setError(err.data?.errors?.join(' ') || err.message); });
    return () => { live = false; };
  }, []);

  return (
    <Stack spacing={2}>
      <Typography variant="h5" component="h1">Reports</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {meta && (
        <Routes>
          <Route index element={<ReportList meta={meta} />} />
          <Route path="new" element={<ReportEditor meta={meta} />} />
          <Route path="new/builder" element={<BuilderEditor meta={meta} />} />
          <Route path="builtin/:key" element={<ReportEditor meta={meta} builtin />} />
          <Route path=":id" element={<ReportEditor meta={meta} />} />
        </Routes>
      )}
    </Stack>
  );
}
