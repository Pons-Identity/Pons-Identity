import { useEffect, useId, useState } from 'react';
import { Alert, Box, Button, Drawer, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import ReadOnlyField from '../../components/ReadOnlyField.jsx';
import { AD_FIELDS, TEXT_FIELDS } from './UserForm.jsx';

// A read-only view of one person, opened from the user list in a drawer. `person` is the list row, or null when closed.
// The full record is loaded when the drawer opens, as the edit page loads it.
export default function UserViewDialog({ person, attrDefs, onClose }) {
  const navigate = useNavigate();
  const titleId = useId();
  const id = person?.id;
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (id == null) return undefined;
    let stale = false;
    setDetail(null);
    setError('');
    api(`/admin/users/${id}`)
      .then((u) => { if (!stale) setDetail(u); })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [id]);

  // A previous person's record is not shown while this one loads.
  const u = detail?.id === id ? detail : null;

  return (
    <Drawer
      anchor="right"
      variant="temporary"
      open={Boolean(person)}
      onClose={onClose}
      slotProps={{ paper: { role: 'dialog', 'aria-labelledby': titleId, sx: { width: { xs: '100%', sm: 480 }, maxWidth: '100%' } } }}
    >
      <Stack sx={{ height: '100%' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 3, py: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="h6" component="h2" id={titleId}>{person ? `User ${person.username}` : ''}</Typography>
          <IconButton aria-label="Close user details" onClick={onClose}><CloseIcon /></IconButton>
        </Stack>
        <Box sx={{ flexGrow: 1, overflowY: 'auto', px: 3, py: 2 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {!u && !error && <Typography color="text.secondary">Loading…</Typography>}
          {u && (
            <Stack spacing={2}>
              <ReadOnlyField label="GUID" value={u.guid} />
              {TEXT_FIELDS.filter(([k]) => k !== 'email').map(([k, label]) => (
                <ReadOnlyField key={k} label={label} value={u[k]} />
              ))}
              {(u.emails || []).map((m) => (
                <ReadOnlyField key={m.email} label={m.primary ? 'Primary email' : 'Email'} value={m.email} />
              ))}
              {!u.directory && <ReadOnlyField label="Personal recovery email" value={u.personal_email} />}
              {AD_FIELDS.map(([k, label]) => (
                <ReadOnlyField key={k} label={label} value={u[k]} />
              ))}
              {attrDefs.map((d) => (
                <ReadOnlyField key={d.name} label={d.label} value={u.attributes?.[d.name]} />
              ))}
              <ReadOnlyField label="Custom attributes" value={u.custom} multiline />
              <ReadOnlyField label="Active" value={u.active ? 'Yes' : 'No'} />
              <ReadOnlyField label="Require MFA" value={person.mfa_required ? 'Yes' : 'No'} />
              <ReadOnlyField label="Locked down" value={u.locked_down ? 'Yes' : 'No'} />
              <ReadOnlyField label="Groups" value={(u.memberships || []).map((g) => g.name).join(', ')} />
            </Stack>
          )}
        </Box>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ px: 3, py: 2, borderTop: 1, borderColor: 'divider' }}>
          <Button onClick={onClose}>Close</Button>
          <Button variant="contained" disabled={!u} onClick={() => { onClose(); navigate(`/admin/users/${id}`); }}>Edit</Button>
        </Stack>
      </Stack>
    </Drawer>
  );
}
