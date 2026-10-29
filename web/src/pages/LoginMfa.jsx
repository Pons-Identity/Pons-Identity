import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Container, Stack, TextField, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import CopyButton from '../components/CopyButton.jsx';

const NAMES = { totp: 'Authenticator app', webauthn: 'Security key or passkey', email: 'Email', sms: 'Text message', voice: 'Phone call' };

// Second step of sign-in: pick one of the methods this account may use now, or set up a first one.
export default function LoginMfa() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const poll = useRef(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await refresh();
        const s = await api('/login/mfa');
        if (!live) return;
        setState(s);
        if (s.factors.length === 1 && !s.enroll) setChosen(s.factors[0]);
      } catch {
        if (live) navigate('/login', { replace: true });
      }
    })();
    return () => { live = false; };
  }, [refresh, navigate]);

  useEffect(() => () => clearInterval(poll.current), []);

  const failed = useCallback((err) => {
    if (err.status === 429) return navigate('/login', { replace: true, state: { error: err.message } });
    setError(err.message);
    return undefined;
  }, [navigate]);

  const finish = (r) => window.location.assign(r.next);

  async function submitTotp(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      finish(await api('/login/mfa', { method: 'POST', body: { code } }));
    } catch (err) { failed(err); setCode(''); } finally { setBusy(false); }
  }

  async function useKey() {
    setBusy(true);
    setError('');
    try {
      const optionsJSON = await api('/login/mfa/webauthn/options', { method: 'POST', body: {} });
      const response = await startAuthentication({ optionsJSON });
      finish(await api('/login/mfa/webauthn/verify', { method: 'POST', body: { response } }));
    } catch (err) {
      failed(err.name === 'NotAllowedError' ? { message: 'The security key request was cancelled or timed out.' } : err);
    } finally { setBusy(false); }
  }

  async function registerKey() {
    setBusy(true);
    setError('');
    try {
      const optionsJSON = await api('/login/mfa/webauthn/enroll/options', { method: 'POST', body: {} });
      const response = await startRegistration({ optionsJSON });
      finish(await api('/login/mfa/webauthn/enroll/verify', { method: 'POST', body: { response } }));
    } catch (err) {
      failed(err.name === 'NotAllowedError' ? { message: 'The security key request was cancelled or timed out.' } : err);
    } finally { setBusy(false); }
  }

  async function send(factor) {
    setBusy(true);
    setError('');
    setCode('');
    clearInterval(poll.current);
    try {
      const c = await api('/login/mfa/challenge', { method: 'POST', body: { factor: factor.id } });
      setChallenge(c);
      // Every way except a typed code waits for an answer on the other device, so the page checks until it has one.
      if (c.mode !== 'code') {
        poll.current = setInterval(async () => {
          try {
            const r = await api('/login/mfa/challenge/status');
            if (r.result === 'failed') { clearInterval(poll.current); setChallenge(null); setError('The approval did not go through. Send a new request.'); }
            else if (r.next) { clearInterval(poll.current); finish(r); }
          } catch (err) { clearInterval(poll.current); failed(err); }
        }, 2000);
      }
    } catch (err) { failed(err); } finally { setBusy(false); }
  }

  async function submitCode(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      finish(await api('/login/mfa/challenge/verify', { method: 'POST', body: { code } }));
    } catch (err) { failed(err); setCode(''); } finally { setBusy(false); }
  }

  function choose(f) {
    clearInterval(poll.current);
    setChosen(f);
    setChallenge(null);
    setError('');
    setCode('');
    if (f.type === 'webauthn') useKey();
  }

  if (!state) return null;
  const { enroll, factors, enroll_options: options = [] } = state;
  const enrolling = Boolean(enroll) || (!factors.length && options.length > 0);

  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h5" component="h1">
              {enrolling ? 'Set up a second step' : chosen ? `Verify with ${NAMES[chosen.type].toLowerCase()}` : 'Choose how to verify'}
            </Typography>
            <Typography color="text.secondary">Signed in as {state.username}</Typography>
            {error && <Alert severity="error">{error}</Alert>}

            {enrolling && options.includes('webauthn') && (
              <Stack spacing={1} alignItems="flex-start">
                <Typography>Register a security key or passkey. It works only on this site, so it cannot be tricked into signing in to a fake one.</Typography>
                <Button variant="contained" onClick={registerKey} disabled={busy}>Register a security key</Button>
              </Stack>
            )}

            {enroll && (
              <Stack component="form" spacing={2} onSubmit={submitTotp}>
                {options.includes('webauthn') && <Typography color="text.secondary">Or use an authenticator app:</Typography>}
                <Typography>Scan this code with an authenticator app, then enter the six-digit code below.</Typography>
                <Box component="img" src={enroll.qr} alt="Authenticator setup QR code" sx={{ width: 200, maxWidth: '100%', bgcolor: 'white', p: 1, borderRadius: 1 }} />
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{enroll.secret}</Typography>
                  <CopyButton value={enroll.secret} label="Copy key" />
                </Stack>
                <TextField label="Six-digit code" name="code" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
                <Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: 'flex-start' }}>Verify</Button>
              </Stack>
            )}

            {!enrolling && factors.length > 1 && (
              <Stack spacing={1}>
                {factors.map((f) => (
                  <Button key={f.id} variant={chosen?.id === f.id ? 'contained' : 'outlined'} onClick={() => choose(f)} disabled={busy} sx={{ justifyContent: 'flex-start' }}>
                    {NAMES[f.type]}{f.hint ? ` (${f.hint})` : f.type === 'webauthn' ? ` (${f.label})` : ''}{f.phishing_resistant ? ' · phishing resistant' : ''}
                  </Button>
                ))}
              </Stack>
            )}

            {!enrolling && chosen?.type === 'totp' && (
              <Stack component="form" spacing={2} onSubmit={submitTotp}>
                <TextField label="Six-digit code" name="code" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
                <Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: 'flex-start' }}>Verify</Button>
              </Stack>
            )}

            {!enrolling && chosen?.type === 'webauthn' && (
              <Stack spacing={1} alignItems="flex-start">
                <Typography>Use your security key or passkey when your browser asks.</Typography>
                <Button variant="contained" onClick={useKey} disabled={busy}>Try again</Button>
              </Stack>
            )}

            {!enrolling && chosen && ['email', 'sms', 'voice'].includes(chosen.type) && (
              <Stack spacing={2}>
                {!challenge && <Button variant="contained" onClick={() => send(chosen)} disabled={busy} sx={{ alignSelf: 'flex-start' }}>
                  {chosen.type === 'voice' ? `Call ${chosen.hint}` : `Send to ${chosen.hint}`}
                </Button>}
                {challenge?.mode === 'code' && (
                  <Stack component="form" spacing={2} onSubmit={submitCode}>
                    <Typography>We sent a code to {challenge.hint}. It expires in 5 minutes.</Typography>
                    <TextField label={`Code (${state.code_length} characters)`} name="code" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)}
                      inputProps={{ maxLength: state.code_length }} autoFocus required />
                    <Stack direction="row" spacing={1}>
                      <Button type="submit" variant="contained" disabled={busy}>Verify</Button>
                      <Button onClick={() => send(chosen)} disabled={busy}>Send again</Button>
                    </Stack>
                  </Stack>
                )}
                {challenge && challenge.mode !== 'code' && (
                  <Stack spacing={1} alignItems="flex-start">
                    {challenge.mode === 'yes_no' && (
                      <Typography>
                        {chosen.type === 'voice'
                          ? `We are calling ${challenge.hint}. Answer the question: press 1 to approve the sign-in, or 2 to deny it.`
                          : `We sent a message to ${challenge.hint}. Reply Y to approve the sign-in, or N to deny it.`}
                      </Typography>
                    )}
                    {challenge.mode !== 'yes_no' && (
                      <>
                        <Typography>
                          {chosen.type === 'voice' && `We are calling ${challenge.hint}. When asked, enter this number on the phone keypad:`}
                          {chosen.type !== 'voice' && challenge.mode === 'yes_no_verified' && `We sent a message to ${challenge.hint}. To approve, reply with this number. To deny, reply N:`}
                          {chosen.type !== 'voice' && challenge.mode === 'number_match' && `We sent a message to ${challenge.hint}. Follow its link, or reply to it, with this number:`}
                        </Typography>
                        <Typography variant="h2" component="p" aria-label={`Number ${challenge.number.split('').join(' ')}`} sx={{ fontFamily: 'monospace', letterSpacing: 8 }}>{challenge.number}</Typography>
                      </>
                    )}
                    <Typography color="text.secondary">Waiting for approval. Do not enter this number anywhere else.</Typography>
                    <Button onClick={() => send(chosen)} disabled={busy}>Send a new request</Button>
                  </Stack>
                )}
              </Stack>
            )}

            <Box><Button onClick={() => navigate('/login')}>Cancel</Button></Box>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
