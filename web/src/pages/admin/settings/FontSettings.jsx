import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, IconButton, MenuItem, Stack, TextField, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { api } from '../../../api/client.js';
import SystemFontSelect from '../../../components/SystemFontSelect.jsx';
import { faceName, guessFace, missingFaces } from '../../../components/fontFace.js';

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const same = (a, b) => Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();

// The system font, the fonts installed here (Google Fonts and uploads) with the faces each one has, and uploads of a family's
// font files. Each file is one face: upright or italic, at a weight. A family needs its bold and italic files too, or the browser
// draws those itself. Writes to the form on the branding page (`value`, `onChange`); the choice is saved with the rest of it.
export default function FontSettings({ value, onChange }) {
  const fileInput = useRef(null);
  const [families, setFamilies] = useState([]);
  // Bumped after each change, so the system font select reloads which Google Fonts are downloaded.
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);

  const load = () => api('/admin/settings/fonts').then((r) => setFamilies(r.families)).catch((e) => setErrors([e.message]));
  useEffect(() => { load(); }, []);

  // The list the server sent back after a change. If the system font is gone with it, the form clears it too.
  function update(list) {
    setFamilies(list);
    setVersion((v) => v + 1);
    if (value && !list.some((f) => same(f.family, value))) onChange('');
  }

  const uploaded = families.filter((f) => f.faces.some((x) => x.source === 'upload')).map((f) => f.family);
  // Google Fonts that are downloaded but not the chosen system font: the ones "Delete unused" removes.
  const unused = families.filter((f) => f.faces.some((x) => x.source === 'google') && !same(f.family, value));
  const clash = picked.some((p, i) => picked.findIndex((q) => q.style === p.style && q.weight === p.weight) !== i);

  function pickFiles(e) {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    setErrors([]);
    setPicked(list.map((file) => ({ file, ...guessFace(file.name) })));
  }

  function setFace(i, patch) {
    setPicked((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async function upload() {
    setErrors([]);
    setBusy(true);
    try {
      // One request per file: the server takes one font file at a time.
      for (const p of picked) {
        const query = new URLSearchParams({ family: name.trim(), style: p.style, weight: String(p.weight), name: p.file.name });
        const body = new Blob([await p.file.arrayBuffer()], { type: 'application/octet-stream' });
        const r = await api(`/admin/settings/fonts?${query}`, { method: 'POST', body });
        update(r.families);
      }
      setPicked([]);
      setName('');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
      load();
    } finally {
      setBusy(false);
    }
  }

  // Runs one delete and applies what the server sent back; a refusal is shown here.
  async function act(path, what) {
    setErrors([]);
    try {
      const r = await api(path, { method: 'DELETE' });
      update(r.families);
      return r;
    } catch (e) {
      setErrors(e.data?.errors || [`${what}: ${e.message}`]);
      return null;
    }
  }

  const removeFamily = (family) => act(`/admin/settings/fonts/${encodeURIComponent(family)}`, `Could not delete ${family}`);
  const removeFace = (family, face) => act(`/admin/settings/fonts/${encodeURIComponent(family)}/faces/${face.style}/${face.weight}`,
    `Could not delete ${faceName(face.style, face.weight)} of ${family}`);

  // Keeps the form's font: it may not be saved yet, and it is what the page is about to use.
  const removeUnused = () => act(`/admin/settings/google-fonts/unused?keep=${encodeURIComponent(value || '')}`, 'Could not delete the unused fonts');

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2">System font</Typography>
      <SystemFontSelect key={version} base="/admin/settings" value={value} onChange={onChange} uploaded={uploaded} />

      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

      <Typography variant="subtitle2">Upload a font</Typography>
      <Typography variant="body2" color="text.secondary">
        Add the files of one family: upright and italic, each at its weight. Upload Bold and Bold italic as their own files. A variable font
        counts as one file, at the weight you pick. Each file is checked for being a font before it is kept.
      </Typography>
      <Stack spacing={2} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
        <TextField label="Family name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy}
          helperText="How the font is named in the list, such as Acme Sans. Uploading to an existing family adds to it." slotProps={{ htmlInput: { maxLength: 60 } }} />
        <Stack direction="row" spacing={1} alignItems="center">
          <input ref={fileInput} type="file" multiple hidden accept=".woff2,.woff,.ttf,.otf" onChange={pickFiles} data-testid="font-input" />
          <Button onClick={() => fileInput.current.click()} disabled={busy}>Choose font files</Button>
          <Typography variant="caption" color="text.secondary">WOFF2, WOFF, TrueType or OpenType, up to 4 MB each.</Typography>
        </Stack>
        {picked.map((p, i) => (
          <Stack key={`${p.file.name}-${i}`} direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
            <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{p.file.name}</Typography>
            <TextField select size="small" label="Style" value={p.style} onChange={(e) => setFace(i, { style: e.target.value })} sx={{ minWidth: 140 }}>
              <MenuItem value="normal">Upright</MenuItem>
              <MenuItem value="italic">Italic</MenuItem>
            </TextField>
            <TextField select size="small" label="Weight" value={p.weight} onChange={(e) => setFace(i, { weight: Number(e.target.value) })} sx={{ minWidth: 160 }}>
              {WEIGHTS.map((w) => <MenuItem key={w} value={w}>{faceName('normal', w)} ({w})</MenuItem>)}
            </TextField>
          </Stack>
        ))}
        {clash && <Alert severity="warning">Two of these files are the same style and weight. Give each file its own.</Alert>}
        <Stack direction="row" spacing={1}>
          <Button variant="contained" onClick={upload} disabled={busy || !picked.length || !name.trim() || clash}>
            {busy ? 'Uploading…' : `Upload ${picked.length} ${picked.length === 1 ? 'file' : 'files'}`}
          </Button>
          {picked.length > 0 && <Button onClick={() => setPicked([])} disabled={busy}>Clear</Button>}
        </Stack>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="space-between">
        <Typography variant="subtitle2">Installed fonts</Typography>
        <Button size="small" color="warning" onClick={removeUnused} disabled={unused.length === 0 || busy}>
          Delete unused Google Fonts{unused.length ? ` (${unused.length})` : ''}
        </Button>
      </Stack>
      {families.length === 0 && <Typography variant="body2" color="text.secondary">No fonts are installed. The browser default is used.</Typography>}
      {families.map((f) => {
        const faces = [...new Map(f.faces.map((x) => [`${x.style}-${x.weight}`, x])).values()];
        const missing = missingFaces(faces);
        const fromGoogle = f.faces.some((x) => x.source === 'google');
        return (
          <Box key={f.family} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography sx={{ fontWeight: 600, flexGrow: 1 }}>{f.family}</Typography>
              <Chip size="small" variant="outlined" label={fromGoogle ? 'Google Fonts' : 'Uploaded'} />
              {same(value, f.family) && <Chip size="small" color="primary" label="System font" />}
              <IconButton aria-label={`Delete ${f.family}`} color="warning" onClick={() => removeFamily(f.family)}><DeleteOutlineIcon /></IconButton>
            </Stack>
            <Stack spacing={0.5}>
              {faces.map((x) => (
                <Stack key={`${x.style}-${x.weight}`} direction="row" alignItems="center" spacing={0.5}>
                  <Typography variant="body2" sx={{ flexGrow: 1 }}>{faceName(x.style, x.weight)}</Typography>
                  <Typography variant="caption" color="text.secondary">{x.source === 'google' ? 'Google' : 'Uploaded'}</Typography>
                  <IconButton size="small" aria-label={`Delete ${faceName(x.style, x.weight)} of ${f.family}`} onClick={() => removeFace(f.family, x)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
            {missing.length > 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Not uploaded: {missing.join(', ')}. The browser draws those faces itself, which usually looks worse.
              </Typography>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}
