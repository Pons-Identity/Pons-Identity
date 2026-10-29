import { useState } from 'react';
import { Box, Chip, Dialog, DialogContent, DialogTitle, Link, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material';

const LEVEL_COLOR = { low: 'default', medium: 'warning', high: 'error' };
const TYPE = { password: 'Password', mfa: 'Second step', signin: 'Sign-in', recovery: 'Recovery' };
const when = (ts) => new Date(ts * 1000).toLocaleString();

export const place = (e) => [e.city, e.region, e.country_name || e.country].filter(Boolean).join(', ');
const network = (e) => (e.asn ? `AS${e.asn}${e.asn_org ? ` ${e.asn_org}` : ''}` : '');
const device = (e) => [e.browser, e.os].filter(Boolean).join(' on ') || 'unknown';
const how = (e) => (e.factor ? e.factor : e.amr && e.amr.length ? e.amr.join('+') : '');

function Detail({ e }) {
  const rows = [
    ['Time', when(e.ts)], ['Person', e.username || '(unknown)'], ['Step', `${TYPE[e.type] || e.type}, ${e.outcome}${e.reason ? ` (${e.reason})` : ''}`],
    ['Method', how(e) || '—'], ['Address', e.ip], ['Place', place(e) || 'unknown'], ['Coordinates (from address)', e.lat !== null && e.lat !== undefined ? `${e.lat}, ${e.lon}` : '—'],
    ['Network', network(e) || 'unknown'], ['Browser', device(e)], ['Kind of device', e.device_type || '—'], ['Device id', e.device_id ? `${e.device_id}${e.device_known === true ? ' (seen before on this account)' : e.device_known === false ? ' (new to this account)' : ''}` : 'no device cookie'],
    ['Location the browser reported', e.device_lat !== null && e.device_lat !== undefined ? `${e.device_lat}, ${e.device_lon}` : '—'],
    ['Risk', e.risk_level ? `${e.risk_score} (${e.risk_level})${e.risk_action ? `, action: ${e.risk_action}` : ''}` : 'not assessed'],
    ['User agent', e.user_agent || '—'], ['Session (hashed)', e.session_id || '—'], ['Request id', e.request_id || '—'],
  ];
  return (
    <Stack spacing={1.5}>
      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.5 }}>
        {rows.map(([k, v]) => (<Box key={k} sx={{ display: 'contents' }}><Typography component="dt" variant="body2" color="text.secondary">{k}</Typography><Typography component="dd" variant="body2" sx={{ m: 0, wordBreak: 'break-word' }}>{v}</Typography></Box>))}
      </Box>
      {e.risk_reasons?.length > 0 && (
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">Why it looked risky</Typography>
          {e.risk_reasons.map((r) => <Typography key={r.code} variant="body2">• {r.detail} <Typography component="span" variant="caption" color="text.secondary">(+{r.weight})</Typography></Typography>)}
        </Stack>
      )}
    </Stack>
  );
}

// Rows of the sign-in log: who, what happened, from where, with what, and how risky it looked. A row opens the full detail.
export default function AuthLogTable({ events, showPerson = true, onPick }) {
  const [open, setOpen] = useState(null);
  return (
    <>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Sign-in log">
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>{showPerson && <TableCell>Person</TableCell>}<TableCell>Result</TableCell><TableCell>Method</TableCell>
              <TableCell>Address</TableCell><TableCell>Device</TableCell><TableCell>Risk</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {events.length === 0 && <TableRow><TableCell colSpan={7}><Typography color="text.secondary">Nothing matches.</Typography></TableCell></TableRow>}
            {events.map((e) => (
              <TableRow key={e.id} hover onClick={() => setOpen(e)} sx={{ cursor: 'pointer' }}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{when(e.ts)}</TableCell>
                {showPerson && <TableCell>{e.username || '—'}</TableCell>}
                <TableCell>
                  <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" alignItems="center">
                    <Chip size="small" color={e.outcome === 'success' ? 'success' : 'error'} variant={e.type === 'signin' ? 'filled' : 'outlined'} label={`${TYPE[e.type] || e.type} ${e.outcome === 'success' ? 'ok' : 'failed'}`} />
                    {e.reason && <Typography variant="caption" color="text.secondary">{e.reason}</Typography>}
                  </Stack>
                </TableCell>
                <TableCell>{how(e)}</TableCell>
                <TableCell>
                  {onPick ? <Link component="button" type="button" onClick={(ev) => { ev.stopPropagation(); onPick({ ip: e.ip }); }}>{e.ip}</Link> : e.ip}
                  <Typography variant="caption" color="text.secondary" display="block">{[place(e), network(e)].filter(Boolean).join(' · ')}</Typography>
                </TableCell>
                <TableCell>
                  {device(e)}
                  {e.device_known === false && <Chip size="small" label="new" sx={{ ml: 0.5 }} />}
                  <Typography variant="caption" color="text.secondary" display="block">{e.device_type}</Typography>
                </TableCell>
                <TableCell>
                  {e.risk_level ? (
                    <Tooltip title={(e.risk_reasons || []).map((r) => r.detail).join('; ') || 'No signals fired'}>
                      <Chip size="small" color={LEVEL_COLOR[e.risk_level]} label={`${e.risk_level} ${e.risk_score}`} />
                    </Tooltip>
                  ) : ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} fullWidth maxWidth="sm">
        <DialogTitle>Sign-in detail</DialogTitle>
        <DialogContent>{open && <Detail e={open} />}</DialogContent>
      </Dialog>
    </>
  );
}
