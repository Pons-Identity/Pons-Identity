import { useEffect, useState } from 'react';
import { Link as RouterLink, Navigate } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Container, Link, Paper, Step, StepLabel, Stepper, Stack, TextField, Typography } from '@mui/material';
import { api } from '../api/client.js';
import { useAuth, useProductName } from '../auth/AuthContext.jsx';
import MigrationPanel, { ImportReport } from '../components/MigrationPanel.jsx';

// The first-run setup wizard. It is open while Pons Identity has no users, to whoever has the one-time token printed on the server's
// console; afterwards it is closed, and a signed-in person with the "Re-run the setup wizard" permission can open it again (it then
// skips the token and the administrator).
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export default function Setup() {
  const { session, refresh } = useAuth();
  const productName = useProductName();
  const [state, setState] = useState(null);
  const [token, setToken] = useState('');
  const [verified, setVerified] = useState(false);
  const [step, setStep] = useState(0);
  const [defaults, setDefaults] = useState(null);
  const [admin, setAdmin] = useState({ username: 'admin', first_name: '', last_name: '', email: '', password: '', confirm: '' });
  const [site, setSite] = useState({ appName: '', primaryColor: '', sessionHours: 8, idleMinutes: 30 });
  const [importPlan, setImportPlan] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => { api('/setup/status').then(setState).catch((e) => setErrors([e.message])); }, []);

  const rerun = state && !state.required && state.canRerun;
  const headers = rerun ? undefined : { 'x-setup-token': token.trim() };

  const loadDefaults = async (h) => {
    const d = await api('/setup/defaults', { headers: h });
    setDefaults(d);
    setSite({ appName: d.branding.appName, primaryColor: d.branding.primaryColor, sessionHours: d.session.sessionHours, idleMinutes: d.session.idleMinutes });
  };
  useEffect(() => { if (rerun) loadDefaults(undefined).catch((e) => setErrors([e.message])); }, [rerun]);

  if (!state) return <Stack alignItems="center" sx={{ mt: 8 }}>{errors.length ? <Alert severity="error">{errors[0]}</Alert> : <CircularProgress />}</Stack>;
  // Nothing to set up, and nobody who may reopen it: this page does not exist for them.
  if (!state.required && !state.canRerun) return <Navigate to="/" replace />;

  const steps = rerun ? ['Your site', 'Import', 'Review'] : ['Setup token', 'Administrator', 'Your site', 'Import', 'Review'];
  const label = steps[step];

  async function checkToken() {
    setErrors([]); setBusy(true);
    try { await api('/setup/verify', { method: 'POST', headers }); await loadDefaults(headers); setVerified(true); setStep(1); } catch (e) { setErrors(e.data?.errors || [e.message]); } finally { setBusy(false); }
  }

  function next() {
    setErrors([]);
    const problems = [];
    if (label === 'Administrator') {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(admin.username)) problems.push('Choose a username of letters, digits, dots, dashes and underscores.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin.email)) problems.push('Enter a valid email address.');
      if (!admin.password) problems.push('Choose a password.');
      else if (admin.password !== admin.confirm) problems.push('The two passwords do not match.');
    }
    if (label === 'Your site') {
      if (!COLOR_RE.test(site.primaryColor)) problems.push('The color must look like #1f5fbf.');
    }
    if (problems.length) return setErrors(problems);
    return setStep(step + 1);
  }

  // Leaves the import step without importing anything, even if a preview was chosen before.
  function skipImport() {
    setErrors([]); setImportPlan(null); setStep(step + 1);
  }

  async function finish() {
    setErrors([]); setBusy(true);
    try {
      const r = await api('/setup/complete', {
        method: 'POST', headers,
        body: {
          ...(rerun ? {} : { admin }),
          branding: { appName: site.appName.trim(), primaryColor: site.primaryColor },
          session: { sessionHours: Number(site.sessionHours), idleMinutes: Number(site.idleMinutes) || 0 },
          ...(importPlan ? { import: importPlan } : {}),
        },
      });
      setDone(r);
      refresh().catch(() => {});
    } catch (e) {
      const list = e.data?.errors || [e.message];
      setErrors(list);
      // A password the rules refuse is fixed on the administrator step.
      if (!rerun && list.some((m) => /password/i.test(m))) setStep(1);
    } finally { setBusy(false); }
  }

  const mismatch = defaults && window.location.origin !== defaults.baseUrl;

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 4 } }}>
        <Stack spacing={3}>
          <Typography variant="h4" component="h1">{rerun ? 'Setup wizard' : `Welcome to ${productName}`}</Typography>
          {done ? (
            <Stack spacing={2}>
              <Alert severity="success">{rerun ? 'Your changes were saved.' : 'Setup is complete. The wizard is now switched off.'}</Alert>
              {done.imported && <ImportReport report={done.imported} />}
              {rerun ? <Button component={RouterLink} to="/" variant="contained" sx={{ alignSelf: 'flex-start' }}>Back to the console</Button>
                : <Button component="a" href="/login" variant="contained" sx={{ alignSelf: 'flex-start' }}>Sign in</Button>}
            </Stack>
          ) : (
            <>
              <Stepper activeStep={step} alternativeLabel>{steps.map((s) => <Step key={s}><StepLabel>{s}</StepLabel></Step>)}</Stepper>
              {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

              {label === 'Setup token' && (
                <Stack spacing={2}>
                  <Typography>
                    This server has no users yet. To make sure it is you setting it up, enter the one-time setup token that {productName} printed on its console (the terminal, or
                    the container log) when it started. It looks like <code>c2f4-cc34-d57a-1a88-5610-717a</code>.
                  </Typography>
                  <TextField label="Setup token" value={token} onChange={(e) => setToken(e.target.value)} autoFocus autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && token && checkToken()} />
                  <Button variant="contained" disabled={busy || !token.trim()} onClick={checkToken} sx={{ alignSelf: 'flex-start' }}>Continue</Button>
                </Stack>
              )}

              {label === 'Administrator' && (
                <Stack spacing={2}>
                  <Typography>Create the first administrator. This account can do everything, so use a long password.</Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                    <TextField label="First name" value={admin.first_name} onChange={(e) => setAdmin({ ...admin, first_name: e.target.value })} fullWidth />
                    <TextField label="Last name" value={admin.last_name} onChange={(e) => setAdmin({ ...admin, last_name: e.target.value })} fullWidth />
                  </Stack>
                  <TextField label="Username" value={admin.username} onChange={(e) => setAdmin({ ...admin, username: e.target.value })} />
                  <TextField label="Email" type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} />
                  <TextField label="Password" type="password" autoComplete="new-password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} />
                  <TextField label="Confirm password" type="password" autoComplete="new-password" value={admin.confirm} onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })} />
                </Stack>
              )}

              {label === 'Your site' && (
                <Stack spacing={2}>
                  <Typography>What people see, and how long they stay signed in. You can change all of this later under Settings.</Typography>
                  {mismatch && (
                    <Alert severity="warning">
                      You opened this page at {window.location.origin}, but {productName} is configured to be at {defaults.baseUrl}. SAML metadata and sign-in links use the configured address; set
                      BASE_URL (or baseUrl in config.json) and restart if it is wrong.
                    </Alert>
                  )}
                  <TextField label="Product name" value={site.appName} onChange={(e) => setSite({ ...site, appName: e.target.value })} helperText="Shown on the sign-in page and in the console. Leave empty for the default name." />
                  <Stack direction="row" spacing={2} alignItems="center">
                    <TextField label="Primary color" value={site.primaryColor} onChange={(e) => setSite({ ...site, primaryColor: e.target.value })} helperText="For example #1f5fbf." />
                    <Box aria-hidden sx={{ width: 40, height: 40, borderRadius: 1, border: 1, borderColor: 'divider', bgcolor: COLOR_RE.test(site.primaryColor) ? site.primaryColor : 'transparent' }} />
                  </Stack>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                    <TextField label="Session length (hours)" type="number" value={site.sessionHours} onChange={(e) => setSite({ ...site, sessionHours: e.target.value })} helperText="1 to 720." />
                    <TextField label="Idle timeout (minutes)" type="number" value={site.idleMinutes} onChange={(e) => setSite({ ...site, idleMinutes: e.target.value })} helperText="0 turns it off; otherwise 5 to 1440." />
                  </Stack>
                </Stack>
              )}

              {label === 'Import' && (
                <Stack spacing={2}>
                  <Typography variant="h6" component="h2">Coming from another identity provider? (optional)</Typography>
                  <MigrationPanel base="/setup/migrate" headers={headers} onPlan={setImportPlan} />
                </Stack>
              )}

              {label === 'Review' && (
                <Stack spacing={1}>
                  <Typography>Ready to finish.</Typography>
                  <Typography component="ul" sx={{ m: 0, pl: 3 }}>
                    {!rerun && <li>Create the administrator <b>{admin.username}</b> ({admin.email}).</li>}
                    <li>Call the product <b>{site.appName.trim() || productName}</b>; sessions last {site.sessionHours} hours{Number(site.idleMinutes) ? `, ending after ${site.idleMinutes} idle minutes` : ''}.</li>
                    <li>{importPlan ? 'Import what you previewed on the last step.' : 'Import nothing (you can do it later under Settings → Migration).'}</li>
                  </Typography>
                  {!rerun && <Typography variant="body2" color="text.secondary">When you finish, the setup wizard switches itself off. Only someone with the “Re-run the setup wizard” permission can open it again, or it reopens by itself if the database is ever emptied of users.</Typography>}
                </Stack>
              )}

              {label !== 'Setup token' && (
                <Stack direction="row" justifyContent="space-between">
                  <Button disabled={busy || step === (rerun ? 0 : 1)} onClick={() => { setErrors([]); setStep(step - 1); }}>Back</Button>
                  <Stack direction="row" spacing={1}>
                    {label === 'Import' && <Button disabled={busy} onClick={skipImport}>Skip this step</Button>}
                    {label === 'Review'
                      ? <Button variant="contained" disabled={busy} onClick={finish}>Finish setup</Button>
                      : <Button variant="contained" onClick={next}>Next</Button>}
                  </Stack>
                </Stack>
              )}
              {!verified && !rerun && label !== 'Setup token' && <Link component="button" onClick={() => setStep(0)}>Enter the setup token</Link>}
            </>
          )}
        </Stack>
      </Paper>
    </Container>
  );
}
