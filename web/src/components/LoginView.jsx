import { useEffect, useMemo, useRef } from 'react';
import { Alert, Box, Button, Card, CardContent, Container, Divider, Stack, TextField, Typography, useTheme } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { renderTemplate, scopeCss } from '../loginTemplate.js';
import { brandPrimary } from '../theme.js';

// The sign-in page. Used for real sign-in and, with `preview`, inside the administrator's editor.
// `template` is the administrator's HTML ('' = the built-in layout); `css` applies to either layout, scoped to .idp-login.
export default function LoginView({ branding, template = '', css = '', federation = false, federationHref, recovery = false, error = '', busy = false, preview = false, onSubmit, defaults = {} }) {
  const form = useRef(null);
  // The custom page's own CSS and template see the primary color for the mode the person is in.
  const primary = brandPrimary(branding, useTheme().palette.mode);
  const html = useMemo(() => (template ? renderTemplate(template, { branding: { ...branding, primaryColor: primary }, federation, federationHref, recovery }) : ''), [template, branding, primary, federation, federationHref, recovery]);
  const vars = { '--idp-primary': primary, '--idp-header': branding.headerColor || primary };
  const wrapper = { minHeight: preview ? 460 : '100vh', position: 'relative' };

  // The custom page's controls are plain HTML, so show the error and the busy state on them directly.
  useEffect(() => {
    const root = form.current;
    if (!root || !template) return;
    root.querySelectorAll('[data-idp="error"]').forEach((el) => { el.textContent = error; el.hidden = !error; });
    root.querySelectorAll('[data-idp="submit"]').forEach((el) => { el.disabled = busy; });
  }, [html, template, error, busy]);

  function submit(e) {
    e.preventDefault();
    if (preview) return;
    const data = new FormData(e.currentTarget);
    onSubmit({ username: String(data.get('username') || ''), password: String(data.get('password') || '') });
  }

  const style = scopeCss(css);
  const content = template ? (
    <form ref={form} onSubmit={submit} noValidate={preview}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </form>
  ) : (
    <Container maxWidth="xs" sx={{ py: preview ? 4 : 8 }}>
      <Card variant="outlined" className="idp-card">
        <CardContent>
          <Stack component="form" spacing={2} onSubmit={submit}>
            {branding.logo && <Box className="idp-logo" component="img" src={branding.logo} alt={branding.appName} sx={{ maxHeight: 64, maxWidth: '100%', alignSelf: 'flex-start', objectFit: 'contain' }} />}
            <Typography className="idp-title" variant="h5" component="h1">Sign in</Typography>
            {branding.loginMessage && <Typography className="idp-message" variant="body2" color="text.secondary">{branding.loginMessage}</Typography>}
            {error && <Alert className="idp-error" severity="error">{error}</Alert>}
            <TextField label="Username" name="username" autoComplete="username" autoFocus={!preview} required className="idp-field"
              defaultValue={defaults.username} slotProps={{ htmlInput: { id: 'username' } }} />
            <TextField label="Password" name="password" type="password" autoComplete="current-password" required className="idp-field"
              slotProps={{ htmlInput: { id: 'password' } }} />
            <Button type="submit" variant="contained" disabled={busy} className="idp-submit">Sign in</Button>
            {recovery && <Button className="idp-recovery" size="small" component={RouterLink} to="/recover" sx={{ alignSelf: 'flex-start' }}>Forgot your password?</Button>}
            {federation && (
              <>
                <Divider>or</Divider>
                <Button className="idp-federation" variant="outlined" component={RouterLink} to={federationHref || '/login/federation'}>
                  Sign in with your institution
                </Button>
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );

  return (
    <Box className="idp-login" style={vars} sx={wrapper}>
      {style && <style>{style}</style>}
      {content}
    </Box>
  );
}
