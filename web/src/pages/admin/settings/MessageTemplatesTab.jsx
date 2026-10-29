import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Chip, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';

const MONO = { style: { fontFamily: 'monospace' } };
const token = (name) => `{{${name}}}`;

// Lists every variable a template may use, so nobody has to guess a name or where it works.
function VariableReference({ kind }) {
  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>Variables</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Write a variable in double braces, for example <code>{token('code')}</code>; it is replaced with the real value when the message is sent.
        Names are case-sensitive. A variable that is not listed for a message type is rejected when you save.
      </Typography>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-label={`${kind.label} variables`}>
          <TableHead>
            <TableRow><TableCell>Variable</TableCell><TableCell>What it contains</TableCell><TableCell>Example</TableCell><TableCell>Works in</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {kind.variables.map((v) => (
              <TableRow key={v.name}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}><code>{token(v.name)}</code></TableCell>
                <TableCell>{v.description}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}><code>{v.example}</code></TableCell>
                <TableCell>{kind.channels.filter((c) => c.variables.includes(v.name)).map((c) => c.label).join(', ')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Box>
  );
}

// One message: its fields, buttons that insert variables where the cursor is, and a preview rendered by the server.
function Editor({ kind, channel, value, defaults, limits, onChange }) {
  const refs = useRef({});
  const active = useRef('body');
  const [preview, setPreview] = useState(null);
  const max = channel.hasSubject ? limits.email : limits[channel.key];

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api('/admin/settings/messaging/templates/preview', { method: 'POST', body: { kind: kind.key, channel: channel.key, subject: value.subject, body: value.body } })
        .then((p) => live && setPreview(p))
        .catch((e) => live && setPreview({ errors: e.data?.errors || [e.message] }));
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [kind.key, channel.key, value.subject, value.body]);

  function insert(name) {
    const field = channel.hasSubject ? active.current : 'body';
    const el = refs.current[field];
    const text = value[field] || '';
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    onChange({ ...value, [field]: text.slice(0, start) + token(name) + text.slice(end) });
    setTimeout(() => { el?.focus(); el?.setSelectionRange(start + token(name).length, start + token(name).length); }, 0);
  }

  const modified = Object.keys(defaults).some((f) => value[f] !== defaults[f]);
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2" color="text.secondary">Insert variable:</Typography>
        {channel.variables.map((n) => <Chip key={n} size="small" variant="outlined" label={token(n)} onClick={() => insert(n)} sx={{ fontFamily: 'monospace' }} />)}
      </Stack>
      {channel.hasSubject && (
        <TextField label="Subject" value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })}
          onFocus={() => { active.current = 'subject'; }} inputRef={(el) => { refs.current.subject = el; }} slotProps={{ htmlInput: MONO }} fullWidth />
      )}
      <TextField label={channel.hasSubject ? 'Body (plain text)' : 'Message'} multiline minRows={channel.hasSubject ? 8 : 4} value={value.body}
        onChange={(e) => onChange({ ...value, body: e.target.value })} onFocus={() => { active.current = 'body'; }} inputRef={(el) => { refs.current.body = el; }}
        helperText={`${value.body.length} of ${max} characters${channel.key === 'sms' && value.body.length > 160 ? '. Longer than 160 characters is sent as several text messages.' : ''}`}
        slotProps={{ htmlInput: MONO }} fullWidth />
      <Box>
        <Typography variant="subtitle2" gutterBottom>Preview with sample values</Typography>
        {preview?.errors && <Alert severity="warning">{preview.errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
        {preview && !preview.errors && (
          <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover' }}>
            {preview.subject !== undefined && <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>{preview.subject}</Typography>}
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{preview.text}</Typography>
          </Box>
        )}
      </Box>
      <Box><Button size="small" disabled={!modified} onClick={() => onChange({ ...defaults })}>Reset to default wording</Button></Box>
    </Stack>
  );
}

function KindCard({ kind, data, onChange }) {
  const [channel, setChannel] = useState('email');
  const ch = kind.channels.find((c) => c.key === channel);
  return (
    <Card variant="outlined"><CardContent>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6" component="h2">{kind.label}</Typography>
          <Typography variant="body2" color="text.secondary">{kind.description}</Typography>
        </Box>
        <VariableReference kind={kind} />
        <Tabs value={channel} onChange={(_, v) => setChannel(v)} aria-label={`${kind.label} channel`}>
          {kind.channels.map((c) => <Tab key={c.key} value={c.key} label={c.label} />)}
        </Tabs>
        <Editor key={channel} kind={kind} channel={ch} value={data.templates[kind.key][channel]} defaults={data.defaults[kind.key][channel]} limits={data.limits}
          onChange={(v) => onChange(kind.key, channel, v)} />
      </Stack>
    </CardContent></Card>
  );
}

export default function MessageTemplatesTab() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api('/admin/settings/messaging/templates').then(setData).catch((e) => setErrors([e.message])); }, []);
  if (!data) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const change = (kind, channel, value) => setData((d) => ({ ...d, templates: { ...d.templates, [kind]: { ...d.templates[kind], [channel]: value } } }));

  async function save() {
    setSaving(true);
    setErrors([]);
    try {
      setData(await api('/admin/settings/messaging/templates', { method: 'PUT', body: data.templates }));
      notify('Message templates saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={3}>
      <PageIntro title="Message templates">
        The wording of the messages sent for sign-in verification codes, password resets and group attestation reminders. Messages are plain text. Delivery itself is set up on the Messaging tab.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      {data.kinds.map((k) => <KindCard key={k.key} kind={k} data={data} onChange={change} />)}
      <Tooltip title="Saves the wording of every message on this page">
        <Box sx={{ alignSelf: 'flex-start' }}><Button variant="contained" onClick={save} disabled={saving}>Save</Button></Box>
      </Tooltip>
    </Stack>
  );
}
