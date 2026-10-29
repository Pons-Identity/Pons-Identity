import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, Card, CardContent, Chip, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { safeNext } from '../safeNext.js';
import CopyButton from '../components/CopyButton.jsx';
import OwnActivity from '../components/OwnActivity.jsx';
import PersonalEmailCard from '../components/PersonalEmailCard.jsx';
import FactorsCard from '../components/FactorsCard.jsx';
import PasswordChangeInfo from '../components/PasswordChangeInfo.jsx';
import { PasswordGuidance } from '../components/PasswordStrength.jsx';
import PassphraseGenerator from '../components/PassphraseGenerator.jsx';
import { useThemeMode } from '../components/BrandedTheme.jsx';

// Self-service profile: password, authenticator (MFA) and color theme.
export default function Profile() {
  const { mode, setMode } = useThemeMode();
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mustChange = Boolean(session.me?.password_change_required);
  const [pw, setPw] = useState({ current_password: '', new_password: '', confirm: '' });
  const [state, setState] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rules, setRules] = useState(null);

  useEffect(() => {
    api('/account/mfa').then(setState).catch((e) => setError(e.message));
    api('/account/password-rules').then(setRules).catch(() => {}); // the form works without the hints
  }, []);

  async function act(method, body, message) {
    setError('');
    setNotice('');
    try {
      const r = await api(`/account/mfa/${method}`, { method: 'POST', body });
      setState({ user: r.user, enroll: r.enroll });
      setNotice(r.notice || message);
      setCode('');
    } catch (e) {
      setError(e.message);
    }
  }

  async function requireMfaNext() {
    setError('');
    setNotice('');
    try {
      const r = await api('/account/mfa/forget', { method: 'POST', body: {} });
      setNotice(r.browsers ? 'You will be asked for your second factor at your next sign-in.' : 'No browser was remembering a second factor. You will be asked at your next sign-in.');
    } catch (e) {
      setError(e.message);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    if (pw.new_password !== pw.confirm) return setError('New passwords do not match.');
    try {
      const r = await api('/account/password', { method: 'POST', body: { current_password: pw.current_password, new_password: pw.new_password } });
      setNotice(r.notice);
      if (r.user) setState((s) => ({ ...s, user: r.user }));
      setPw({ current_password: '', new_password: '', confirm: '' });
      if (mustChange) {
        // The requirement is met: reload who is signed in, then carry on to where the person was headed (a protocol request resumes server-side).
        await refresh();
        const next = safeNext(params.get('next'), '/');
        if (/^\/(oidc|oauth2|cas|saml)\//.test(next)) window.location.assign(next); else navigate(next === '/account/profile' ? '/' : next, { replace: true });
      }
    } catch (err) {
      setError(err.message);
    }
  }

  if (!state) return error ? <Alert severity="error">{error}</Alert> : null;
  const { user, enroll } = state;

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">Profile</Typography>
      {mustChange && <Alert severity="warning">Your organization’s password rules changed. Choose a new password that meets them to continue.</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2">Password</Typography>
            {user.can_change_password && <PasswordChangeInfo info={user.password} viewer="self" />}
            {user.can_change_password ? (
              <Stack component="form" spacing={2} onSubmit={changePassword} sx={{ maxWidth: 360 }}>
                <TextField label="Current password" type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} required />
                <TextField label="New password" type="password" autoComplete="new-password" helperText={rules ? undefined : 'At least 12 characters.'} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} required />
                <PassphraseGenerator onUse={(phrase) => setPw({ ...pw, new_password: phrase, confirm: phrase })} />
                <PasswordGuidance rules={rules} password={pw.new_password} userInputs={[user.username, user.email].filter(Boolean)} />
                <TextField label="Confirm new password" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
                <Button type="submit" variant="contained" sx={{ alignSelf: 'flex-start' }}>Change password</Button>
              </Stack>
            ) : (
              <Typography color="text.secondary">Your password is managed by your directory.</Typography>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="h6" component="h2">Authenticator app</Typography>
              <Chip size="small" label={user.totp_enabled ? 'Enabled' : 'Not set up'} color={user.totp_enabled ? 'success' : 'default'} />
            </Stack>

            {!user.totp_enabled && enroll && (
              <Stack spacing={2} alignItems="flex-start">
                <Typography>Scan this code with an authenticator app, then enter the six-digit code to turn it on.</Typography>
                <Box component="img" src={enroll.qr} alt="Authenticator setup QR code" sx={{ width: 200, maxWidth: '100%', bgcolor: 'white', p: 1, borderRadius: 1 }} />
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{enroll.secret}</Typography>
                  <CopyButton value={enroll.secret} label="Copy key" />
                </Stack>
                <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); act('enable', { code }); }}>
                  <TextField label="Six-digit code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" required />
                  <Button type="submit" variant="contained" sx={{ alignSelf: 'flex-start' }}>Turn on</Button>
                </Stack>
              </Stack>
            )}

            {user.totp_enabled && !user.mfa_enabled && (
              <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); act('disable', { code }, 'Authenticator removed.'); }}>
                <Typography color="text.secondary">Enter a current code to remove the authenticator.</Typography>
                <TextField label="Six-digit code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" required />
                <Button type="submit" color="error" variant="outlined" sx={{ alignSelf: 'flex-start' }}>Remove authenticator</Button>
              </Stack>
            )}

            {user.totp_enabled && user.mfa_enabled && (
              <Typography color="text.secondary">An administrator requires MFA for your account, so the authenticator cannot be removed.</Typography>
            )}
          </Stack>
        </CardContent>
      </Card>

      <FactorsCard />

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2} alignItems="flex-start">
            <Typography variant="h6" component="h2">Remembered browsers</Typography>
            <Typography color="text.secondary">
              A browser where you completed a second factor may skip it again for a while, as your sign-in rules allow.
              Use this to be asked for it at your next sign-in, from every browser.
            </Typography>
            <Button variant="outlined" onClick={requireMfaNext}>Require MFA at my next sign-in</Button>
          </Stack>
        </CardContent>
      </Card>

      <PersonalEmailCard />

      <OwnActivity />

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2">Color theme</Typography>
            <ToggleButtonGroup exclusive value={mode} onChange={(_, m) => m && setMode(m)} aria-label="Color theme" sx={{ alignSelf: 'flex-start' }}>
              <ToggleButton value="system">System</ToggleButton>
              <ToggleButton value="light">Light</ToggleButton>
              <ToggleButton value="dark">Dark</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="body2" color="text.secondary">Saved in this browser.</Typography>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
