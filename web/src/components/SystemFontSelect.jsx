import { useEffect, useState } from 'react';
import { Alert, ListSubheader, MenuItem, Stack, TextField } from '@mui/material';
import { api } from '../api/client.js';

// Choosing the system font. A common Google Font is downloaded to this server the first time it is chosen, so browsers never
// contact Google. `uploaded` lists the families the administrator uploaded. `base` is the settings' API path (the wizard's or
// the console's) and `headers` any extra headers it needs (the wizard's token).
export default function SystemFontSelect({ base, headers, value, onChange, uploaded = [], label = 'System font' }) {
  const [catalog, setCatalog] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`${base}/google-fonts`, { headers }).then(setCatalog).catch((e) => setErrors([e.message]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  const google = catalog?.families || [];
  const googleNames = new Set(google.map((f) => f.family));
  // A family saved earlier that is no longer in either list still shows, so the select does not lie about the saved value.
  const custom = [...new Set([...uploaded, value].filter(Boolean))].filter((f) => !googleNames.has(f));

  async function pick(e) {
    const family = e.target.value;
    setErrors([]);
    const entry = google.find((f) => f.family === family);
    if (!entry || entry.installed) return onChange(family);
    setBusy(true);
    try {
      await api(`${base}/google-fonts/${encodeURIComponent(family)}`, { method: 'POST', headers });
      setCatalog((c) => ({ ...c, families: c.families.map((f) => (f.family === family ? { ...f, installed: true } : f)) }));
      onChange(family);
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={1}>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      {catalog?.error && <Alert severity="warning">{catalog.error}</Alert>}
      <TextField select label={label} value={value || ''} onChange={pick} disabled={busy}
        helperText={busy ? 'Downloading the font from Google Fonts…' : 'Google Fonts are downloaded to this server the first time one is chosen.'}>
        <MenuItem value="">Browser default</MenuItem>
        {google.length > 0 && <ListSubheader>Google Fonts</ListSubheader>}
        {google.map((f) => (
          <MenuItem key={f.family} value={f.family}>{f.installed ? f.family : `${f.family} (not downloaded yet)`}</MenuItem>
        ))}
        {custom.length > 0 && <ListSubheader>Uploaded</ListSubheader>}
        {custom.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
      </TextField>
    </Stack>
  );
}
