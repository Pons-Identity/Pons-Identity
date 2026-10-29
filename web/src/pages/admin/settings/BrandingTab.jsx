import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, FormControlLabel, Stack, Switch, TextField, ThemeProvider, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import useFontStylesheet from '../../../components/useFontStylesheet.js';
import { MIN_CONTRAST } from '../../../contrast.js';
import { brandPrimary, contrastProblems, makeTheme } from '../../../theme.js';
import FontSettings from './FontSettings.jsx';
import { brandImages } from '../../../components/brandImages.js';
import BrandHeading from '../../../components/BrandHeading.jsx';
import ImageRolePicker from './ImageRolePicker.jsx';

// loginTemplate/loginCss belong to the Sign-in page tab; they ride along so saving branding never clears them.
const DEFAULTS = { appName: 'Pons Identity', namePropagation: true, primaryColor: '#1f5fbf', darkPrimaryColor: '#7cb4ff', headerColor: '', fontFamily: '', logoImage: '', wordmarkImage: '', faviconImage: '', logo: '', loginMessage: '' };
const HEX = /^#[0-9a-fA-F]{6}$/;

// A hex field with a native color picker beside it.
function ColorField({ label, value, onChange, fallback, helperText }) {
  return (
    <Stack direction="row" spacing={1} alignItems="flex-start">
      <TextField label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={fallback}
        error={Boolean(value) && !HEX.test(value)} helperText={helperText} sx={{ flexGrow: 1 }} />
      {/* A fixed size that does not shrink, so both pickers are the same width whatever their helper text. */}
      <Box component="input" type="color" aria-label={`${label} picker`} value={HEX.test(value) ? value : fallback}
        onChange={(e) => onChange(e.target.value)}
        sx={{ display: 'block', flexShrink: 0, boxSizing: 'border-box', width: 56, minWidth: 56, height: 56, p: 0.5, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'transparent' }} />
    </Stack>
  );
}

// The branding as the preview and the warnings should see it: a color that is not valid yet falls back, so the theme can be made.
const previewable = (form) => ({
  ...form,
  primaryColor: HEX.test(form.primaryColor) ? form.primaryColor : DEFAULTS.primaryColor,
  darkPrimaryColor: HEX.test(form.darkPrimaryColor) ? form.darkPrimaryColor : DEFAULTS.darkPrimaryColor,
});

const ratioText = (r) => `${r.toFixed(2)}:1`;

// Says where the primary color is too faint, in each mode. Nothing is said while a color is still being typed.
function ContrastWarnings({ form }) {
  if (!HEX.test(form.primaryColor) || !HEX.test(form.darkPrimaryColor)) return null;
  const branding = previewable(form);
  const modes = [['light', 'Light mode'], ['dark', 'Dark mode']];
  const problems = modes.flatMap(([mode, name]) => contrastProblems(branding, mode).map((p) => ({ ...p, name })));
  if (!problems.length) return null;
  return (
    <Alert severity="warning">
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        Some text would be hard to read (WCAG asks for {MIN_CONTRAST}:1 or more):
      </Typography>
      {problems.map((p) => <div key={`${p.name}-${p.what}`}>{p.name}: {p.what.toLowerCase()} is {ratioText(p.ratio)}.</div>)}
      <Typography variant="body2" sx={{ mt: 0.5 }}>Choose a darker or lighter color for that mode.</Typography>
    </Alert>
  );
}

// One mode of the preview, drawn with the real theme for that mode. The button is a real button that does nothing when pressed,
// so its hover and pressed colors can be tried out.
function Preview({ branding, mode, assets }) {
  const theme = useMemo(() => makeTheme(branding, mode), [branding, mode]);
  const header = HEX.test(branding.headerColor) ? branding.headerColor : brandPrimary(branding, mode);
  const { logo, wordmark } = brandImages(branding, assets);
  return (
    <ThemeProvider theme={theme}>
      <Stack spacing={0.5}>
        <Typography variant="overline" color="text.secondary">{mode === 'dark' ? 'Dark mode' : 'Light mode'}</Typography>
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.default', color: 'text.primary' }}
          aria-label={`${mode === 'dark' ? 'Dark mode' : 'Light mode'} preview`}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1.5, bgcolor: header, color: theme.palette.getContrastText(header) }}>
            <BrandHeading appName={branding.appName || DEFAULTS.appName} logo={logo} wordmark={wordmark} height={28} />
          </Stack>
          <Stack spacing={1.5} sx={{ p: 2 }}>
            <Typography variant="subtitle1">Sign in</Typography>
            {/* Shows the faces the font has: regular, bold, italic and bold italic. */}
            <Typography variant="body2">Regular, <b>bold</b>, <i>italic</i> and <b><i>bold italic</i></b>.</Typography>
            {branding.loginMessage && <Typography variant="body2" color="text.secondary">{branding.loginMessage}</Typography>}
            <Typography variant="body2" sx={{ color: 'primary.main' }}>A link looks like this.</Typography>
            <Box>
              <Button variant="contained" type="button" onClick={(e) => e.preventDefault()}>Sign in</Button>
            </Box>
          </Stack>
        </Box>
      </Stack>
    </ThemeProvider>
  );
}

export default function BrandingTab() {
  const { refresh } = useAuth();
  const notify = useNotify();
  const [images, setImages] = useState([]);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/admin/settings/branding').then(setForm).catch((e) => setErrors([e.message]));
    api('/admin/settings/assets').then((r) => setImages(r.assets)).catch(() => {});
  }, []);
  // The preview shows the chosen font before it is saved, so it loads under its own id, apart from the site's font.
  useFontStylesheet(form?.fontFamily, 'preview-font');

  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const branding = previewable(form);
  const assetUrls = Object.fromEntries(images.map((a) => [a.name, a.url]));

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
              <ColorField label="Primary color, light mode" value={form.primaryColor} onChange={(v) => set('primaryColor', v)} fallback={DEFAULTS.primaryColor}
                helperText="Buttons, links and highlights in light mode." />
              <ColorField label="Primary color, dark mode" value={form.darkPrimaryColor} onChange={(v) => set('darkPrimaryColor', v)} fallback={DEFAULTS.darkPrimaryColor}
                helperText="Buttons, links and highlights in dark mode. The light-mode color is not used there." />
              <ContrastWarnings form={form} />
              <ColorField label="Header color" value={form.headerColor} onChange={(v) => set('headerColor', v)} fallback={DEFAULTS.primaryColor}
                helperText="Leave empty to use the primary color of the mode." />
              <ImageRolePicker label="Logo" help="A square image, shown to the left of the heading in the header. Does not change the sign-in page."
                value={form.logoImage} onChange={(v) => set('logoImage', v)} images={images} onImages={setImages} />
              <ImageRolePicker label="Logotype (wordmark)" help="A wide image of the name as text. Shown in the header in place of the heading."
                value={form.wordmarkImage} onChange={(v) => set('wordmarkImage', v)} images={images} onImages={setImages} />
              <ImageRolePicker label="Favicon" help="The browser tab icon: a square PNG, JPEG, GIF or WebP. Left empty, the logo is converted to an icon."
                value={form.faviconImage} onChange={(v) => set('faviconImage', v)} images={images} onImages={setImages} />
              <FontSettings value={form.fontFamily} onChange={(v) => set('fontFamily', v)} />
              <TextField label="Sign-in message" multiline minRows={2} value={form.loginMessage} onChange={(e) => set('loginMessage', e.target.value)}
                helperText="Optional text shown above the sign-in form." slotProps={{ htmlInput: { maxLength: 300 } }} />
              <Stack direction="row" spacing={1}>
                <Button type="submit" variant="contained" disabled={saving}>Save</Button>
                <Button onClick={() => setForm((f) => ({ ...f, ...DEFAULTS }))}>Reset to defaults</Button>
              </Stack>
            </Stack>
            <Stack spacing={2}>
              <Typography variant="overline" color="text.secondary">Preview</Typography>
              <Preview branding={branding} assets={assetUrls} mode="light" />
              <Preview branding={branding} assets={assetUrls} mode="dark" />
              <Typography variant="caption" color="text.secondary">Changes apply to everyone after you save. The button can be pressed to see its colors, and it goes nowhere.</Typography>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}
