import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Checkbox, Chip, FormControlLabel, FormGroup, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import LoginView from '../../../components/LoginView.jsx';
import { MAX_CSS, MAX_TEMPLATE, STARTER_CSS, STARTER_TEMPLATE, VARIABLES, missingVariables, unknownVariables } from '../../../loginTemplate.js';

function VariableTable({ onInsert }) {
  return (
    <Table size="small" aria-label="Template variables">
      <TableHead>
        <TableRow><TableCell>Variable</TableCell><TableCell>Type</TableCell><TableCell>What it becomes</TableCell></TableRow>
      </TableHead>
      <TableBody>
        {VARIABLES.map((v) => (
          <TableRow key={v.name}>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>
              <Tooltip title="Insert at the cursor"><Chip size="small" label={`{{${v.name}}}`} onClick={() => onInsert(`{{${v.name}}}`)} sx={{ fontFamily: 'monospace' }} /></Tooltip>
            </TableCell>
            <TableCell>{v.kind === 'input' ? `Form field${v.required ? ' (required)' : ''}` : 'Display value'}</TableCell>
            <TableCell>{v.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Protection() {
  const notify = useNotify();
  const [cfg, setCfg] = useState(null);
  const [errors, setErrors] = useState([]);

  useEffect(() => { api('/admin/settings/login-page-protection').then(setCfg).catch((e) => setErrors([e.message])); }, []);
  if (!cfg) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const toggleRole = (id) => setCfg((c) => ({ ...c, notifyRoleIds: c.notifyRoleIds.includes(id) ? c.notifyRoleIds.filter((r) => r !== id) : [...c.notifyRoleIds, id] }));

  async function save(e) {
    e.preventDefault();
    setErrors([]);
    try {
      setCfg(await api('/admin/settings/login-page-protection', { method: 'PUT', body: cfg }));
      notify('Copy protection saved');
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    }
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack component="form" spacing={2} onSubmit={save}>
          <Typography variant="h6" component="h2">Copy detection</Typography>
          <Typography variant="body2" color="text.secondary">
            A browser has to download the CSS to draw your page, so copying cannot be made impossible. The server hides the template and CSS from scrapers
            (it only answers your own sign-in page), refuses and reports requests that look automated or cross-site, and puts a hidden beacon in the CSS:
            if a copy of it is hosted on another site, that site's name is reported. Copies made with the Referer header removed are not detected.
          </Typography>
          {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
          <FormControlLabel control={<Switch checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />} label="Detect and report copy attempts" />
          <Box>
            <Typography variant="subtitle2">Email people who hold these roles</Typography>
            <FormGroup>
              {cfg.roles.map((r) => (
                <FormControlLabel key={r.id} label={r.name}
                  control={<Checkbox checked={cfg.notifyRoleIds.includes(r.id)} onChange={() => toggleRole(r.id)} />} />
              ))}
            </FormGroup>
            {!cfg.emailConfigured && <Alert severity="warning" sx={{ mt: 1 }}>Email delivery is not set up (Settings → Messaging), so alerts are recorded in the audit log only.</Alert>}
          </Box>
          <TextField label="Minutes between alerts" type="number" value={cfg.cooldownMinutes} sx={{ maxWidth: 240 }}
            onChange={(e) => setCfg({ ...cfg, cooldownMinutes: e.target.value === '' ? '' : Number(e.target.value) })}
            helperText="At most one email per source in this time. Every event is still in the audit log (login_page.*)." />
          <Box><Button type="submit" variant="contained">Save</Button></Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

export default function LoginPageTab() {
  const { session, refresh } = useAuth();
  const notify = useNotify();
  const templateRef = useRef(null);
  const cssFile = useRef(null);
  const [saved, setSaved] = useState(null); // full branding as stored
  const [custom, setCustom] = useState(false);
  const [template, setTemplate] = useState('');
  const [css, setCss] = useState('');
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showFederation, setShowFederation] = useState(Boolean(session.config?.federationLogin));
  const [view, setView] = useState('preview');

  useEffect(() => {
    api('/admin/settings/branding').then((b) => {
      setSaved(b);
      setCustom(Boolean(b.loginTemplate));
      setTemplate(b.loginTemplate || '');
      setCss(b.loginCss || '');
    }).catch((e) => setErrors([e.message]));
  }, []);

  if (!saved) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const active = custom ? template : '';
  const problems = custom && template.trim()
    ? [...unknownVariables(template).map((n) => `Unknown variable {{${n}}}.`), ...missingVariables(template).map((n) => `Missing required {{${n}}}.`),
      ...(/<\s*script/i.test(template) ? ['Scripts are not allowed.'] : [])]
    : [];

  function insert(text) {
    const el = templateRef.current;
    if (!el) return setTemplate((t) => t + text);
    const { selectionStart: a, selectionEnd: b } = el;
    setTemplate(template.slice(0, a) + text + template.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + text.length, a + text.length); });
  }

  function toggleCustom(on) {
    setCustom(on);
    if (on && !template.trim()) setTemplate(STARTER_TEMPLATE);
  }

  function pickCss(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_CSS) return setErrors([`CSS file must be smaller than ${MAX_CSS.toLocaleString()} characters.`]);
    const reader = new FileReader();
    reader.onload = () => { setErrors([]); setCss(String(reader.result)); };
    reader.readAsText(file);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const b = await api('/admin/settings/branding', { method: 'PUT', body: { ...saved, loginTemplate: custom ? template : '', loginCss: css } });
      setSaved(b);
      await refresh();
      notify('Sign-in page saved');
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={3}>
      <PageIntro title="Sign-in page" />
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'grid', gap: 4, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
            <Stack component="form" spacing={2.5} onSubmit={save}>
              {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
              <FormControlLabel control={<Switch checked={custom} onChange={(e) => toggleCustom(e.target.checked)} />} label="Use my own sign-in page layout" />
              {custom && (
                <>
                  <TextField label="Page template (HTML)" multiline minRows={10} value={template} inputRef={templateRef}
                    onChange={(e) => setTemplate(e.target.value)} error={problems.length > 0} spellCheck={false}
                    helperText={problems.length ? problems.join(' ') : `Use the variables below. Scripts, forms and frames are removed. ${template.length.toLocaleString()} / ${MAX_TEMPLATE.toLocaleString()}`}
                    slotProps={{ htmlInput: { maxLength: MAX_TEMPLATE, style: { fontFamily: 'monospace', fontSize: 13 } } }} />
                  <VariableTable onInsert={insert} />
                </>
              )}
              <TextField label="Custom CSS" multiline minRows={8} value={css} onChange={(e) => setCss(e.target.value)} spellCheck={false}
                helperText={`Applies to the built-in page and to your layout, only on the sign-in page. Built-in classes: idp-card, idp-title, idp-message, idp-logo, idp-field, idp-submit, idp-error, idp-federation. No @import or remote url(). ${css.length.toLocaleString()} / ${MAX_CSS.toLocaleString()}`}
                slotProps={{ htmlInput: { maxLength: MAX_CSS, style: { fontFamily: 'monospace', fontSize: 13 } } }} />
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <input ref={cssFile} type="file" hidden accept=".css,text/css" onChange={pickCss} data-testid="css-input" />
                <Button onClick={() => cssFile.current.click()}>Upload CSS file</Button>
                <Button onClick={() => setCss(STARTER_CSS)}>Insert example CSS</Button>
                {css && <Button color="warning" onClick={() => setCss('')}>Clear CSS</Button>}
              </Stack>
              <Stack direction="row" spacing={1}>
                <Button type="submit" variant="contained" disabled={saving || problems.length > 0}>Save</Button>
              </Stack>
            </Stack>
            <Stack spacing={1}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap spacing={1}>
                <Typography variant="overline" color="text.secondary">Preview</Typography>
                <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && setView(v)} aria-label="Preview state">
                  <ToggleButton value="preview">Normal</ToggleButton>
                  <ToggleButton value="error">With error</ToggleButton>
                </ToggleButtonGroup>
              </Stack>
              <FormControlLabel control={<Switch size="small" checked={showFederation} onChange={(e) => setShowFederation(e.target.checked)} />} label="Show institution sign-in" />
              <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.default' }} aria-label="Sign-in page preview">
                <LoginView preview branding={saved} template={active} css={css} federation={showFederation}
                  federationHref="#" error={view === 'error' ? 'Invalid username or password.' : ''} defaults={{ username: 'alex' }} />
              </Box>
              <Typography variant="caption" color="text.secondary">
                The preview uses your unsaved edits and cannot sign anyone in. It does not include the hidden copy-detection beacon.
              </Typography>
            </Stack>
          </Box>
        </CardContent>
      </Card>
      <Protection />
    </Stack>
  );
}
