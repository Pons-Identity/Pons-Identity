import { useEffect, useMemo, useRef, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, CardContent, Checkbox, Chip, FormControlLabel, FormGroup, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import LoginView from '../../../components/LoginView.jsx';
import CodeEditor from '../../../components/CodeEditor.jsx';
import { cssHover, htmlHover } from '../../../components/signInHover.js';
import { fontClass } from '../../../components/fontClass.js';
import { MAX_CSS, MAX_TEMPLATE, STARTER_CSS, STARTER_TEMPLATE, VARIABLES, missingVariables, sampleMarkup, unknownVariables } from '../../../loginTemplate.js';
import { BackgroundControls, ImageLibrary } from './SignInImages.jsx';
import ImageRolePicker from './ImageRolePicker.jsx';
import { ClassesReference, FontsReference, ImageExamples } from './SignInHelp.jsx';

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

  const toggle = (key, id) => setCfg((c) => ({ ...c, [key]: c[key].includes(id) ? c[key].filter((x) => x !== id) : [...c[key], id] }));
  const toggleRole = (id) => toggle('notifyRoleIds', id);
  const toggleGroup = (id) => toggle('notifyGroupIds', id);

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
          </Box>
          <Box>
            <Typography variant="subtitle2">Email members of these groups</Typography>
            <Typography variant="caption" color="text.secondary">Members include people in groups nested inside these. Each person is emailed once.</Typography>
            {cfg.groups.length === 0 && <Typography variant="body2" color="text.secondary">No groups yet.</Typography>}
            <FormGroup sx={{ maxHeight: 240, overflowY: 'auto', flexWrap: 'nowrap' }}>
              {cfg.groups.map((g) => (
                <FormControlLabel key={g.id} label={g.name}
                  control={<Checkbox checked={cfg.notifyGroupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />} />
              ))}
            </FormGroup>
          </Box>
          {!cfg.emailConfigured && <Alert severity="warning">Email delivery is not set up (Settings → Messaging), so alerts are recorded in the audit log only.</Alert>}
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
  const editorTemplate = useRef(null);
  const cssFile = useRef(null);
  const [saved, setSaved] = useState(null); // full branding as stored
  const [custom, setCustom] = useState(false);
  const [template, setTemplate] = useState('');
  const [css, setCss] = useState('');
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showFederation, setShowFederation] = useState(Boolean(session.config?.federationLogin));
  const [view, setView] = useState('preview');
  const [previewMode, setPreviewMode] = useState('light');
  const [images, setImages] = useState([]);
  const [fonts, setFonts] = useState([]);
  const [bg, setBg] = useState({ loginBackground: '', loginBackgroundColor: '', loginBackgroundBlur: 0, loginBackgroundBrightness: 100, loginBackgroundContrast: 100 });
  const [roles, setRoles] = useState({ loginLogoImage: '', loginWordmarkImage: '' });
  const [notice, setNotice] = useState({ loginNotice: '', loginNoticePlacement: 'below-card', loginNoticePanel: true, loginNoticeColor: 'white', loginNoticeAlign: 'center' });

  // The hover tips read what they need through this, so they follow the editors' unsaved text without being rebuilt.
  const latest = useRef({});
  const assetUrls = Object.fromEntries(images.map((a) => [a.name, a.url]));
  const fontClasses = Object.fromEntries(fonts.map((f) => [fontClass(f.family), f.family]));
  latest.current = { template: custom ? template : '', branding: { ...(saved || {}), ...bg }, assetUrls, fontClasses };
  const hoverOptions = useMemo(() => ({
    markup: () => sampleMarkup(latest.current.template, latest.current.branding),
    assets: () => latest.current.assetUrls,
    fontClasses: () => latest.current.fontClasses,
    where: () => (latest.current.template ? 'your layout' : 'the built-in page'),
  }), []);
  const cssHoverTips = useMemo(() => cssHover(hoverOptions), [hoverOptions]);
  const htmlHoverTips = useMemo(() => htmlHover(hoverOptions), [hoverOptions]);

  useEffect(() => {
    api('/admin/settings/branding').then((b) => {
      setSaved(b);
      setRoles({ loginLogoImage: b.loginLogoImage || '', loginWordmarkImage: b.loginWordmarkImage || '' });
      setNotice({
        loginNotice: b.loginNotice || '', loginNoticePlacement: b.loginNoticePlacement || 'below-card', loginNoticePanel: b.loginNoticePanel !== false,
        loginNoticeColor: b.loginNoticeColor || 'white', loginNoticeAlign: b.loginNoticeAlign || 'center',
      });
      setCustom(Boolean(b.loginTemplate));
      setTemplate(b.loginTemplate || '');
      setCss(b.loginCss || '');
      setBg({
        loginBackground: b.loginBackground || '', loginBackgroundColor: b.loginBackgroundColor || '', loginBackgroundBlur: b.loginBackgroundBlur ?? 0,
        loginBackgroundBrightness: b.loginBackgroundBrightness ?? 100, loginBackgroundContrast: b.loginBackgroundContrast ?? 100,
      });
    }).catch((e) => setErrors([e.message]));
    api('/admin/settings/assets').then((r) => setImages(r.assets)).catch(() => {});
    api('/admin/settings/fonts').then((r) => setFonts(r.families)).catch(() => {});
  }, []);

  if (!saved) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const active = custom ? template : '';
  const problems = custom && template.trim()
    ? [...unknownVariables(template).map((n) => `Unknown variable {{${n}}}.`), ...missingVariables(template).map((n) => `Missing required {{${n}}}.`),
      ...(/<\s*script/i.test(template) ? ['Scripts are not allowed.'] : [])]
    : [];

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
      // Fetched first, so fields changed on the Branding page since this one opened are kept.
      const current = await api('/admin/settings/branding');
      const b = await api('/admin/settings/branding', { method: 'PUT', body: { ...current, loginTemplate: custom ? template : '', loginCss: css, ...bg, ...roles, ...notice } });
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
          <Stack spacing={4}>
            <Stack spacing={1}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap spacing={1}>
                <Typography variant="overline" color="text.secondary">Preview</Typography>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <ToggleButtonGroup size="small" exclusive value={previewMode} onChange={(_, v) => v && setPreviewMode(v)} aria-label="Preview color mode">
                    <ToggleButton value="light">Light</ToggleButton>
                    <ToggleButton value="dark">Dark</ToggleButton>
                  </ToggleButtonGroup>
                  <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && setView(v)} aria-label="Preview state">
                    <ToggleButton value="preview">Normal</ToggleButton>
                    <ToggleButton value="error">With error</ToggleButton>
                  </ToggleButtonGroup>
                </Stack>
              </Stack>
              <FormControlLabel control={<Switch size="small" checked={showFederation} onChange={(e) => setShowFederation(e.target.checked)} />} label="Show institution sign-in" />
              <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.default' }} aria-label="Sign-in page preview">
                <LoginView preview mode={previewMode} branding={{ ...saved, ...bg, ...roles, ...notice }} assets={assetUrls} template={active} css={css} federation={showFederation}
                  federationHref="#" error={view === 'error' ? 'Invalid username or password.' : ''} defaults={{ username: 'alex' }} />
              </Box>
              <Typography variant="caption" color="text.secondary">
                The preview uses your unsaved edits and cannot sign anyone in. It does not include the hidden copy-detection beacon.
              </Typography>
            </Stack>
            <Stack component="form" spacing={2.5} onSubmit={save}>
              {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
              <FormControlLabel control={<Switch checked={custom} onChange={(e) => toggleCustom(e.target.checked)} />} label="Use my own sign-in page layout" />
              {custom && (
                <>
                  <CodeEditor ref={editorTemplate} label="Page template (HTML)" language="html" languages={['html', 'text']} fileName="sign-in-page.html"
                    value={template} onChange={setTemplate} hover={htmlHoverTips} maxLength={MAX_TEMPLATE} wordWrap error={problems.length > 0}
                    helperText={problems.length ? problems.join(' ') : 'Use the variables below. Scripts, forms and frames are removed. Hover a {{variable}}, class or file name for details.'} />
                  <VariableTable onInsert={(text) => editorTemplate.current?.insert(text)} />
                </>
              )}
              <CodeEditor label="Custom CSS" language="css" languages={['css', 'text']} fileName="sign-in-page.css" value={css} onChange={setCss}
                hover={cssHoverTips} maxLength={MAX_CSS} wordWrap
                helperText="Applies to the built-in page and to your layout, only on the sign-in page. No @import or remote url(). Hover a selector or a property to see the elements it matches." />
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <input ref={cssFile} type="file" hidden accept=".css,text/css" onChange={pickCss} data-testid="css-input" />
                <Button onClick={() => cssFile.current.click()}>Upload CSS file</Button>
                <Button onClick={() => setCss(STARTER_CSS)}>Insert example CSS</Button>
                {css && <Button color="warning" onClick={() => setCss('')}>Clear CSS</Button>}
              </Stack>
              <Accordion disableGutters variant="outlined" defaultExpanded>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>Logo and logotype</AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={3}>
                    {saved.logo && !roles.loginLogoImage && (
                      <Alert severity="info">A logo uploaded before is in use until you choose a sign-in logo here.</Alert>
                    )}
                    <ImageRolePicker label="Sign-in logo" help="A square image, shown on the sign-in card. Does not change the header."
                      value={roles.loginLogoImage} onChange={(v) => setRoles({ ...roles, loginLogoImage: v })} images={images} onImages={setImages} />
                    <ImageRolePicker label="Sign-in wordmark" help="A wide image of the name as text. Shown on the sign-in card when there is no sign-in logo. Does not change the header."
                      value={roles.loginWordmarkImage} onChange={(v) => setRoles({ ...roles, loginWordmarkImage: v })} images={images} onImages={setImages} />
                  </Stack>
                </AccordionDetails>
              </Accordion>
              <Accordion disableGutters variant="outlined">
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>Images and background</AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={3}>
                    <ImageLibrary images={images} onChange={setImages} />
                    <BackgroundControls value={bg} onChange={setBg} images={images} />
                  </Stack>
                </AccordionDetails>
              </Accordion>
              <Accordion disableGutters variant="outlined">
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>Text on the page</AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
                    <TextField label="Text (Markdown)" multiline minRows={3} fullWidth value={notice.loginNotice} inputProps={{ maxLength: 2000 }}
                      onChange={(e) => setNotice({ ...notice, loginNotice: e.target.value })}
                      helperText="Headings, lists, **bold**, *italic*, `code` and links such as [the help desk](https://example.org/help). Up to 2,000 characters." />
                    <ToggleButtonGroup size="small" exclusive value={notice.loginNoticePlacement} aria-label="Where the text sits"
                      onChange={(_, v) => v && setNotice({ ...notice, loginNoticePlacement: v })}>
                      <ToggleButton value="below-card">Below the card</ToggleButton>
                      <ToggleButton value="footer">Footer</ToggleButton>
                    </ToggleButtonGroup>
                    {notice.loginNoticePlacement === 'below-card' ? (
                      <Stack spacing={2} sx={{ alignItems: 'flex-start' }} data-testid="notice-below-options">
                        <FormControlLabel control={<Switch checked={notice.loginNoticePanel} onChange={(e) => setNotice({ ...notice, loginNoticePanel: e.target.checked })} />}
                          label="Show the text on a dark translucent panel" />
                        <Stack spacing={1}>
                          <Typography variant="body2" color="text.secondary">Text color</Typography>
                          <ToggleButtonGroup size="small" exclusive value={notice.loginNoticeColor} aria-label="Text color"
                            onChange={(_, v) => v && setNotice({ ...notice, loginNoticeColor: v })}>
                            <ToggleButton value="white">White</ToggleButton>
                            <ToggleButton value="black">Black</ToggleButton>
                          </ToggleButtonGroup>
                        </Stack>
                        <Stack spacing={1}>
                          <Typography variant="body2" color="text.secondary">Alignment</Typography>
                          <ToggleButtonGroup size="small" exclusive value={notice.loginNoticeAlign} aria-label="Text alignment"
                            onChange={(_, v) => v && setNotice({ ...notice, loginNoticeAlign: v })}>
                            <ToggleButton value="left">Left</ToggleButton>
                            <ToggleButton value="center">Centered</ToggleButton>
                            <ToggleButton value="right">Right</ToggleButton>
                          </ToggleButtonGroup>
                        </Stack>
                        {notice.loginNoticeColor === 'black' && notice.loginNoticePanel && (
                          <Alert severity="warning">Black text on the dark panel is hard to read. Use white text with the panel, or turn the panel off.</Alert>
                        )}
                        {notice.loginNoticeColor === 'white' && !notice.loginNoticePanel && (
                          <Typography variant="caption" color="text.secondary">
                            Without the panel, white text is only readable over a dark background or a dark picture. Check the preview over your picture.
                          </Typography>
                        )}
                      </Stack>
                    ) : (
                      <Typography variant="caption" color="text.secondary">The footer is a solid bar in the header color, with its text centered.</Typography>
                    )}
                  </Stack>
                </AccordionDetails>
              </Accordion>
              <Accordion disableGutters variant="outlined">
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>Fonts for the page</AccordionSummary>
                <AccordionDetails><FontsReference fonts={fonts} /></AccordionDetails>
              </Accordion>
              <Accordion disableGutters variant="outlined">
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>Classes of the built-in page</AccordionSummary>
                <AccordionDetails><ClassesReference /></AccordionDetails>
              </Accordion>
              <Accordion disableGutters variant="outlined">
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>Using uploaded images</AccordionSummary>
                <AccordionDetails><ImageExamples name={images[0]?.name || 'background.png'} /></AccordionDetails>
              </Accordion>
              <Stack direction="row" spacing={1}>
                <Button type="submit" variant="contained" disabled={saving || problems.length > 0}>Save</Button>
              </Stack>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
      <Protection />
    </Stack>
  );
}
