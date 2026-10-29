import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, FormControlLabel, Stack, Switch, TextField, Typography, useTheme } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { useNotify } from '../../../components/Notify.jsx';

// loginTemplate/loginCss belong to the Sign-in page tab; they ride along so saving branding never clears them.
const DEFAULTS = { appName: 'Pons Identity', namePropagation: true, primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const MAX_LOGO = 256 * 1024;
const HEX = /^#[0-9a-fA-F]{6}$/;

// A hex field with a native color picker beside it.
function ColorField({ label, value, onChange, fallback, helperText }) {
  return (
    <Stack direction="row" spacing={1} alignItems="flex-start">
      <TextField label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder="#1f5fbf"
        error={Boolean(value) && !HEX.test(value)} helperText={helperText} sx={{ flexGrow: 1 }} />
      <Box component="input" type="color" aria-label={`${label} picker`} value={HEX.test(value) ? value : fallback}
        onChange={(e) => onChange(e.target.value)} sx={{ width: 48, height: 56, p: 0.5, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'transparent' }} />
    </Stack>
  );
}

function Preview({ form }) {
  const { palette } = useTheme();
  const primary = HEX.test(form.primaryColor) ? form.primaryColor : DEFAULTS.primaryColor;
  const header = HEX.test(form.headerColor) ? form.headerColor : primary;
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }} aria-label="Preview">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1.5, bgcolor: header, color: palette.getContrastText(header) }}>
        {form.logo && <Box component="img" src={form.logo} alt="" sx={{ height: 28, maxWidth: 100, objectFit: 'contain' }} />}
        <Typography variant="h6">{form.appName || DEFAULTS.appName}</Typography>
      </Stack>
      <Stack spacing={1.5} sx={{ p: 2 }}>
        <Typography variant="subtitle1">Sign in</Typography>
        {form.loginMessage && <Typography variant="body2" color="text.secondary">{form.loginMessage}</Typography>}
        <Box>
          <Box component="span" sx={{ display: 'inline-block', px: 2, py: 0.75, borderRadius: 1, bgcolor: primary, color: palette.getContrastText(primary), fontWeight: 500 }}>
            Sign in
          </Box>
        </Box>
      </Stack>
    </Box>
  );
}

export default function BrandingTab() {
  const { refresh } = useAuth();
  const notify = useNotify();
  const fileInput = useRef(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/admin/settings/branding').then(setForm).catch((e) => setErrors([e.message]));
  }, []);

  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  function pickLogo(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_LOGO) return setErrors(['Logo must be smaller than 256 KB.']);
    const reader = new FileReader();
    reader.onload = () => { setErrors([]); set('logo', String(reader.result)); };
    reader.readAsDataURL(file);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      setForm(await api('/admin/settings/branding', { method: 'PUT', body: form }));
      await refresh();
      notify('Branding saved');
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={3}>
      <PageIntro title="Branding" />
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'grid', gap: 4, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
            <Stack component="form" spacing={2.5} onSubmit={save}>
              {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
              <TextField label="Product name" value={form.appName} onChange={(e) => set('appName', e.target.value)}
                helperText="Shown in the header, on the sign-in page and as the browser tab title. Leave empty for the default name." slotProps={{ htmlInput: { maxLength: 40 } }} />
              <Stack spacing={0.5}>
                <FormControlLabel label="Name propagation"
                  control={<Switch checked={Boolean(form.namePropagation)} onChange={(e) => set('namePropagation', e.target.checked)} />} />
                <Typography variant="caption" color="text.secondary">
                  Use this name everywhere the product is named: messages, help and generated files. When off, those keep the default name. The header, sign-in page and browser title always use the name above.
                </Typography>
              </Stack>
              <ColorField label="Primary color" value={form.primaryColor} onChange={(v) => set('primaryColor', v)} fallback={DEFAULTS.primaryColor}
                helperText="Buttons, links and highlights." />
              <ColorField label="Header color" value={form.headerColor} onChange={(v) => set('headerColor', v)} fallback={DEFAULTS.primaryColor}
                helperText="Leave empty to use the primary color." />
              <Stack direction="row" spacing={2} alignItems="center">
                {form.logo && <Box component="img" src={form.logo} alt="Current logo" sx={{ height: 40, maxWidth: 160, objectFit: 'contain' }} />}
                <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" onChange={pickLogo} data-testid="logo-input" />
                <Button onClick={() => fileInput.current.click()}>{form.logo ? 'Replace logo' : 'Upload logo'}</Button>
                {form.logo && <Button color="warning" onClick={() => set('logo', '')}>Remove</Button>}
              </Stack>
              <TextField label="Sign-in message" multiline minRows={2} value={form.loginMessage} onChange={(e) => set('loginMessage', e.target.value)}
                helperText="Optional text shown above the sign-in form." slotProps={{ htmlInput: { maxLength: 300 } }} />
              <Stack direction="row" spacing={1}>
                <Button type="submit" variant="contained" disabled={saving}>Save</Button>
                <Button onClick={() => setForm((f) => ({ ...f, ...DEFAULTS }))}>Reset to defaults</Button>
              </Stack>
            </Stack>
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary">Preview</Typography>
              <Preview form={form} />
              <Typography variant="caption" color="text.secondary">Changes apply to everyone after you save.</Typography>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}
