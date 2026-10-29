import { useEffect, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Button, Checkbox, FormControlLabel, IconButton, MenuItem, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { api } from '../../../api/client.js';
import CopyTextField from '../../../components/CopyTextField.jsx';
import { toPayload } from './spForm.js';

const HELP = [
  ['lower(x), upper(x), trim(x)', 'Change case or strip spaces from every value'],
  ['concat(a, b, ...)', 'Join the first value of each argument: concat(username, "@example.com")'],
  ['replace(x, "regex", "text")', 'Regular-expression replace: replace(department, "^Eng", "Engineering")'],
  ['extract(x, "regex", n)', 'Keep capture group n (default 1); values that do not match are dropped'],
  ['split(x, "sep", n)', 'Part n after splitting; negative n counts from the end: split(email, "@", 0)'],
  ['substring(x, start, length)', 'Part of each value; length is optional'],
  ['coalesce(a, b, ...)', 'The first argument that has a value'],
  ['join(x, "sep"), first(x)', 'Combine a multi-valued attribute into one value, or keep only its first value'],
  ['attr("name"), drop()', 'Refer to an attribute whose name is not a plain word; remove the attribute'],
];

const EMPTY_ROW = { expression: '', saml_name: '', nameid: false, temp: false };

function TransformationTable({ form, set }) {
  const off = !form.transform_enabled;
  const rows = form.transforms;
  const nameIdTaken = rows.some((r) => r.nameid);
  const update = (i, patch) => set('transforms', rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => set('transforms', rows.filter((_, j) => j !== i));

  return (
    <Stack spacing={1.5}>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Attribute transformations">
          <TableHead>
            <TableRow>
              <TableCell>Transformation rules</TableCell>
              <TableCell>SAML response attribute</TableCell>
              <TableCell>Options</TableCell>
              <TableCell padding="checkbox"><span hidden>Actions</span></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && <TableRow><TableCell colSpan={4}>No transformations.</TableCell></TableRow>}
            {rows.map((row, i) => (
              <TableRow key={i} sx={{ '& > td': { verticalAlign: 'top' } }}>
                <TableCell sx={{ minWidth: 280 }}>
                  <CopyTextField multiline minRows={3} fullWidth size="small" disabled={off} value={row.expression}
                    copyLabel={`transformation rule ${i + 1}`}
                    placeholder={'lower(mail)'} helperText="Create the transformation rules you'd like to apply."
                    onChange={(e) => update(i, { expression: e.target.value })}
                    slotProps={{ htmlInput: { 'aria-label': `Transformation rule ${i + 1}` }, input: { sx: { fontFamily: 'monospace', fontSize: 14 } } }} />
                </TableCell>
                <TableCell sx={{ minWidth: 240 }}>
                  <CopyTextField fullWidth size="small" disabled={off} value={row.saml_name}
                    copyLabel={`transformed SAML attribute ${i + 1}`}
                    helperText="Enter the SAML response attribute you'd like to apply the transformation to."
                    onChange={(e) => update(i, { saml_name: e.target.value })}
                    slotProps={{ htmlInput: { 'aria-label': `Transformed SAML attribute ${i + 1}` } }} />
                </TableCell>
                <TableCell sx={{ minWidth: 220 }}>
                  <Stack>
                    <FormControlLabel label="Set this as my NameID attribute" disabled={off || (nameIdTaken && !row.nameid)}
                      control={<Checkbox checked={row.nameid} onChange={(e) => update(i, { nameid: e.target.checked })}
                        slotProps={{ input: { 'aria-label': `Set transformation ${i + 1} as my NameID attribute` } }} />} />
                    <FormControlLabel label="Use as temporary attribute" disabled={off}
                      control={<Checkbox checked={row.temp} onChange={(e) => update(i, { temp: e.target.checked })}
                        slotProps={{ input: { 'aria-label': `Use transformation ${i + 1} as temporary attribute` } }} />} />
                  </Stack>
                </TableCell>
                <TableCell padding="checkbox">
                  <IconButton aria-label={`Remove transformation ${i + 1}`} disabled={off} onClick={() => remove(i)}><DeleteIcon /></IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Button startIcon={<AddIcon />} disabled={off} sx={{ alignSelf: 'flex-start' }}
        onClick={() => set('transforms', [...rows, { ...EMPTY_ROW }])}>Add transformation</Button>
    </Stack>
  );
}

// Rules that rewrite the attributes after mapping, with a live preview for a chosen user.
export default function Transformations({ form, set }) {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [preview, setPreview] = useState(null);
  const [failed, setFailed] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api('/admin/users').then((us) => {
      setUsers(us);
      setUserId((cur) => cur || (us[0] ? String(us[0].id) : ''));
    }).catch((e) => setFailed(e.message));
  }, []);

  // Re-run the preview shortly after the form changes, using the unsaved values.
  const payload = JSON.stringify({ ...toPayload(form), user_id: userId });
  useEffect(() => {
    if (!userId || !open) return undefined;
    let current = true;
    const t = setTimeout(() => {
      api('/admin/sps/preview', { method: 'POST', body: JSON.parse(payload) })
        .then((p) => { if (current) { setPreview(p); setFailed(''); } })
        .catch((e) => { if (current) setFailed(e.message); });
    }, 400);
    return () => { current = false; clearTimeout(t); };
  }, [payload, userId, open]);

  return (
    <Accordion variant="outlined" disableGutters expanded={open} onChange={(_, v) => setOpen(v)}
      slotProps={{ transition: { unmountOnExit: true } }} sx={{
        '&:before': { display: 'none' },
        borderRadius: 1,
        // MUI zeroes the top margin of an expanded first-of-type accordion, which drops the parent Stack's spacing.
        '&.Mui-expanded:first-of-type': { marginTop: 3 },
      }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="transformations-body" id="transformations-header">
        <Typography variant="h6" component="h2">Attribute transformations</Typography>
      </AccordionSummary>
      <AccordionDetails id="transformations-body">
        <Stack spacing={2}>
          <FormControlLabel label="Enable attribute transformations" control={
            <Checkbox checked={form.transform_enabled} onChange={(e) => set('transform_enabled', e.target.checked)} />} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: '0 !important' }}>
            Attribute transformation rules allow you to manipulate attributes from your authentication source to meet the needs of your service provider.
          </Typography>
          <TransformationTable form={form} set={set} />
          <Accordion variant="outlined" disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>Functions</AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1}>
                {HELP.map(([sig, text]) => (
                  <Typography key={sig} variant="body2"><code>{sig}</code>: {text}</Typography>
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>

          <Typography variant="subtitle1" component="h3">Preview</Typography>
          <TextField select size="small" label="Preview as user" value={userId} onChange={(e) => setUserId(e.target.value)} sx={{ maxWidth: 360 }}
            helperText="Shows the attributes this user would receive, using the unsaved values on this page.">
            {users.map((u) => <MenuItem key={u.id} value={String(u.id)}>{u.display_name || u.username} ({u.username})</MenuItem>)}
          </TextField>
          {failed && <Alert severity="error">{failed}</Alert>}
          {preview?.errors.length > 0 && <Alert severity="warning">{preview.errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
          {preview && (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label="Attribute preview">
                <TableHead><TableRow><TableCell>SAML attribute</TableCell><TableCell>Value(s)</TableCell></TableRow></TableHead>
                <TableBody>
                  <TableRow>
                    <TableCell>NameID ({form.nameid_format})</TableCell>
                    <TableCell sx={{ wordBreak: 'break-all' }}>{preview.nameId ?? <em>not available</em>}</TableCell>
                  </TableRow>
                  {preview.attributes.map((a) => (
                    <TableRow key={a.name}>
                      <TableCell sx={{ wordBreak: 'break-all' }}>{a.name}</TableCell>
                      <TableCell sx={{ wordBreak: 'break-all' }}>{a.values.join(', ')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {!userId && <Typography variant="body2" color="text.secondary">Create a user to preview the attributes.</Typography>}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
