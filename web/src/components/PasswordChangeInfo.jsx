import { Typography } from '@mui/material';

const VIA = { self: 'the user', admin: 'an administrator', recovery: 'password recovery', api: 'the API', bulk: 'a bulk import' };

// SQLite stores UTC as "YYYY-MM-DD HH:MM:SS".
const when = (s) => new Date(`${s.replace(' ', 'T')}Z`).toLocaleString();

// Who last set a password and when. `viewer` is 'admin' (names the person) or 'self' (addresses the user).
export default function PasswordChangeInfo({ info, viewer = 'admin' }) {
  if (!info) return <Typography variant="body2" color="text.secondary">Password change history is not available.</Typography>;
  const name = info.by && (info.by.display_name || info.by.username);
  let who;
  if (info.by_self || info.via === 'recovery') who = viewer === 'self' ? (info.via === 'recovery' ? 'through password recovery' : 'by you') : `by the user${info.via === 'recovery' ? ' (recovery)' : ''}`;
  else if (info.via === 'admin') who = name ? `by administrator ${name}` : 'by an administrator';
  else who = `by ${VIA[info.via] || 'the system'}${name ? ` (${name})` : ''}`;
  return <Typography variant="body2" color="text.secondary">Password last changed {when(info.changed_at)} {who}.</Typography>;
}
