import { MenuItem, Stack, TextField } from '@mui/material';

export const EMPTY_CONNECTION = { url: '', version: 'v2_5_000', username: '', password: '' };
export const DEFAULT_LOOKUP = { lookupBy: 'subjectId', subjectSourceId: '', timeZone: 'UTC' };

// The Grouper web services connection and how people are looked up. The password lives only in the parent's state:
// it is sent with each request and never saved by the server.
export default function GrouperConnection({ conn, onConn, lookup, onLookup }) {
  const edit = (set, key) => (e) => set((v) => ({ ...v, [key]: e.target.value }));
  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField label="Web services URL" value={conn.url} onChange={edit(onConn, 'url')} placeholder="https://grouper.example.net/grouper-ws/servicesRest" fullWidth />
        <TextField label="API version" value={conn.version} onChange={edit(onConn, 'version')} sx={{ minWidth: 160 }} />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField label="Username" value={conn.username} onChange={edit(onConn, 'username')} autoComplete="off" />
        <TextField label="Password" type="password" value={conn.password} onChange={edit(onConn, 'password')} autoComplete="new-password" />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Look people up by" value={lookup.lookupBy} onChange={edit(onLookup, 'lookupBy')} sx={{ minWidth: 220 }}>
          <MenuItem value="subjectId">Subject ID</MenuItem>
          <MenuItem value="subjectIdentifier">Subject identifier</MenuItem>
        </TextField>
        <TextField label="Subject source ID (optional)" value={lookup.subjectSourceId} onChange={edit(onLookup, 'subjectSourceId')} helperText="For example ldap or jdbc." />
        <TextField label="Grouper server time zone" value={lookup.timeZone} onChange={edit(onLookup, 'timeZone')} helperText="Used for membership dates." />
      </Stack>
    </Stack>
  );
}
