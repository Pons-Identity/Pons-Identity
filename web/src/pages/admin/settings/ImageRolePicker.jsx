import { useRef, useState } from 'react';
import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { api } from '../../../api/client.js';

// Chooses the uploaded image for one role (logo, wordmark, favicon): from the image library, or by uploading a new file, which is
// added to the library and chosen. `value` is the image's name; `images` and `onImages` are the library the settings page holds.
export default function ImageRolePicker({ label, help, value, onChange, images, onImages }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const chosen = images.find((a) => a.name === value);

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setErrors([]);
    try {
      const body = new Blob([await file.arrayBuffer()], { type: 'application/octet-stream' });
      const r = await api(`/admin/settings/assets?${new URLSearchParams({ name: file.name })}`, { method: 'POST', body });
      onImages(r.assets);
      onChange(r.name);
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{label}</Typography>
      <Typography variant="caption" color="text.secondary">{help}</Typography>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Box sx={{ width: 64, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 1, borderColor: 'divider', borderRadius: 1, p: 0.5, flexShrink: 0 }}>
          {chosen && <Box component="img" src={chosen.url} alt={`${label} preview`} sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
        </Box>
        <TextField select size="small" label="Image" value={value} onChange={(e) => onChange(e.target.value)} sx={{ minWidth: 200 }}>
          <MenuItem value="">None</MenuItem>
          {images.map((a) => <MenuItem key={a.name} value={a.name}>{a.name}</MenuItem>)}
        </TextField>
        <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={upload} aria-label={`${label} file`} />
        <Button onClick={() => input.current.click()} disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</Button>
      </Stack>
    </Stack>
  );
}
