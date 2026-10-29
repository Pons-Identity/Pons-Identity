import { useEffect, useMemo, useState } from 'react';
import { Alert, Autocomplete, Stack, TextField, createFilterOptions } from '@mui/material';
import { api } from '../api/client.js';

// Choosing the system font: a search over every Google Font, the browser default, or a font the administrator uploaded. A Google
// Font is downloaded to this server the first time it is chosen, so browsers never contact Google. `uploaded` lists the families
// the administrator uploaded. `base` is the settings' API path (the wizard's or the console's) and `headers` any extra headers it
// needs (the wizard's token).
const filter = createFilterOptions({ limit: 200 });

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
  // Options come grouped: the default, then the uploads, then every Google Font. A family saved earlier that is in neither list
  // still shows, so the field does not lie about the saved value.
  const options = useMemo(() => {
    const custom = [...new Set([...uploaded, value].filter(Boolean))].filter((f) => !googleNames.has(f));
    return [
      { value: '', label: 'Browser default', group: 'Default' },
      ...custom.map((f) => ({ value: f, label: f, group: 'Uploaded' })),
      ...google.map((f) => ({ value: f.family, label: f.installed ? f.family : `${f.family} (downloads when chosen)`, group: 'Google Fonts', installed: f.installed })),
    ];
  }, [google, googleNames, uploaded, value]);
  const selected = options.find((o) => o.value === (value || '')) || { value: value || '', label: value || 'Browser default', group: 'Default' };

  async function pick(option) {
    if (!option || option.value === (value || '')) return;
    setErrors([]);
    if (option.group !== 'Google Fonts' || option.installed) return onChange(option.value);
    setBusy(true);
    try {
      await api(`${base}/google-fonts/${encodeURIComponent(option.value)}`, { method: 'POST', headers });
      setCatalog((c) => ({ ...c, families: c.families.map((f) => (f.family === option.value ? { ...f, installed: true } : f)) }));
      onChange(option.value);
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
      <Autocomplete options={options} value={selected} onChange={(_, o) => pick(o)} disabled={busy} disableClearable
        groupBy={(o) => o.group} getOptionLabel={(o) => o.label} isOptionEqualToValue={(a, b) => a.value === b.value}
        filterOptions={filter} renderOption={(props, o) => <li {...props} key={`${o.group}-${o.value}`}>{o.label}</li>}
        renderInput={(params) => (
          <TextField {...params} label={label}
            helperText={busy ? 'Downloading the font from Google Fonts…' : 'Type to search all Google Fonts. A Google Font is downloaded to this server the first time it is chosen.'} />
        )} />
    </Stack>
  );
}
