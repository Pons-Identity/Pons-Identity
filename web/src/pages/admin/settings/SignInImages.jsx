import { useRef, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, IconButton, MenuItem, Slider, Stack, Switch, TextField, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';

const MAX_IMAGE = 2 * 1024 * 1024;

// Pictures for the sign-in page. A file is kept under its own name, which is how the page refers to it: `<img src="logo.png">` in
// HTML, `url('logo.png')` in CSS. `images` is the list the server has ({ name, url, bytes }); `onChange` gets the new list.
export function ImageLibrary({ images, onChange }) {
  const notify = useNotify();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);

  async function pick(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    setErrors([]);
    setBusy(true);
    const problems = [];
    // One request per file: the server takes one image at a time.
    for (const f of files) {
      if (f.size > MAX_IMAGE) {
        problems.push(`${f.name} is larger than 2 MB.`);
        continue;
      }
      try {
        const body = new Blob([await f.arrayBuffer()], { type: 'application/octet-stream' });
        const r = await api(`/admin/settings/assets?${new URLSearchParams({ name: f.name })}`, { method: 'POST', body });
        onChange(r.assets);
      } catch (err) {
        problems.push(...(err.data?.errors || [err.message]));
      }
    }
    setBusy(false);
    if (problems.length) setErrors(problems);
  }

  async function remove(name) {
    setErrors([]);
    try {
      const r = await api(`/admin/settings/assets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      onChange(r.assets);
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      notify('Copied');
    } catch {
      notify('Copying is blocked here. Select the text and copy it.');
    }
  }

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        Upload pictures for the sign-in page: a background, a logo, or pictures in your own layout. PNG, JPEG, GIF or WebP, up to 2 MB each.
        Each keeps its file name, which the page refers to.
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <input ref={input} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={pick} data-testid="image-input" />
        <Button onClick={() => input.current.click()} disabled={busy}>{busy ? 'Uploading…' : 'Upload images'}</Button>
      </Stack>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      {images.length === 0 && <Typography variant="body2" color="text.secondary">No images yet.</Typography>}
      {images.map((a) => (
        <Stack key={a.name} direction="row" spacing={1.5} alignItems="center" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
          <Box component="img" src={a.url} alt="" sx={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 1, border: 1, borderColor: 'divider', flexShrink: 0 }} />
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{a.name}</Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
              <Button size="small" onClick={() => copy(`<img src="${a.name}" alt="">`)}>Copy HTML</Button>
              <Button size="small" onClick={() => copy(`background-image: url('${a.name}');`)}>Copy CSS</Button>
            </Stack>
          </Box>
          <IconButton aria-label={`Delete ${a.name}`} color="warning" onClick={() => remove(a.name)}><DeleteOutlineIcon /></IconButton>
        </Stack>
      ))}
    </Stack>
  );
}

// The background behind the built-in sign-in page's card: a picture, with blur, dimming (brightness) and contrast. Only the built-in
// layout draws it; a custom layout puts a picture in its own CSS.
export function BackgroundControls({ value, onChange, images }) {
  const set = (key, v) => onChange({ ...value, [key]: v });
  const blurOn = value.loginBackgroundBlur > 0;
  const dimOn = value.loginBackgroundBrightness < 100;
  return (
    <Stack spacing={2}>
      <TextField select label="Background picture" value={value.loginBackground} onChange={(e) => set('loginBackground', e.target.value)}
        helperText={images.length ? 'Fills the page behind the sign-in card on the built-in layout.' : 'Upload a picture above to use it as the background.'}>
        <MenuItem value="">None</MenuItem>
        {images.map((a) => <MenuItem key={a.name} value={a.name}>{a.name}</MenuItem>)}
      </TextField>
      <FormControlLabel label="Blur the background"
        control={<Switch checked={blurOn} disabled={!value.loginBackground} onChange={(e) => set('loginBackgroundBlur', e.target.checked ? 6 : 0)} />} />
      {blurOn && (
        <Slider aria-label="Blur amount in pixels" min={1} max={30} step={1} valueLabelDisplay="auto" value={value.loginBackgroundBlur}
          onChange={(_, v) => set('loginBackgroundBlur', v)} marks={[{ value: 1, label: '1 px' }, { value: 30, label: '30 px' }]} />
      )}
      <FormControlLabel label="Dim the background"
        control={<Switch checked={dimOn} disabled={!value.loginBackground} onChange={(e) => set('loginBackgroundBrightness', e.target.checked ? 70 : 100)} />} />
      {dimOn && (
        <Slider aria-label="Brightness of the background in percent" min={20} max={100} step={1} valueLabelDisplay="auto" value={value.loginBackgroundBrightness}
          valueLabelFormat={(v) => `${v}%`} onChange={(_, v) => set('loginBackgroundBrightness', v)} />
      )}
      <Typography variant="body2" color="text.secondary">Contrast: 100% leaves the picture as it is. Brightness below 100% dims it.</Typography>
      <Slider aria-label="Contrast of the background in percent" min={50} max={150} step={1} valueLabelDisplay="auto" value={value.loginBackgroundContrast}
        valueLabelFormat={(v) => `${v}%`} disabled={!value.loginBackground} onChange={(_, v) => set('loginBackgroundContrast', v)}
        marks={[{ value: 100, label: '100%' }]} />
    </Stack>
  );
}
