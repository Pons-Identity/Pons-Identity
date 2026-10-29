import { useEffect, useMemo, useRef } from 'react';
import { Alert, Box, Button, Card, CardContent, Container, Divider, Stack, TextField, ThemeProvider, Typography, useTheme } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { DEFAULT_CARD_CSS, PREVIEW_IGNORE, renderTemplate, scopeCss } from '../loginTemplate.js';
import { brandPrimary, makeTheme, signInBackdrop } from '../theme.js';
import { bestText } from '../contrast.js';
import Markdown from './Markdown.jsx';
import { signInImages } from './brandImages.js';

// The sign-in page. Used for real sign-in and, with `preview`, inside the administrator's editor.
// `template` is the administrator's HTML ('' = the built-in layout); `css` applies to either layout, scoped to .idp-login.
// `assets` maps the names of uploaded images to their addresses, so the page can refer to them by name.
// `mode` ('light' or 'dark') shows the page in that mode whatever the viewer's own choice is: the administrator's preview uses it.
// Without it the page follows the viewer's color theme.
export default function LoginView({ mode, ...props }) {
  if (!mode) return <SignInPage {...props} />;
  return <ThemeProvider theme={makeTheme(props.branding, mode)}><SignInPage {...props} /></ThemeProvider>;
}

function SignInPage({ branding, template = '', css = '', assets = {}, federation = false, federationHref, recovery = false, error = '', busy = false, preview = false, onSubmit, defaults = {} }) {
  const form = useRef(null);
  const mode = useTheme().palette.mode;
  // The custom page's own CSS and template see the primary color for the mode the person is in.
  const primary = brandPrimary(branding, mode);
  // The mode is also a class on the page's content, so CSS can style each mode (.idp-dark .idp-card). display: contents keeps the
  // content's layout as it was without the class.
  const modeClass = mode === 'dark' ? 'idp-dark' : 'idp-light';
  const html = useMemo(() => (template ? renderTemplate(template, { branding: { ...branding, primaryColor: primary }, federation, federationHref, recovery, assets, preview }) : ''),
    [template, branding, primary, federation, federationHref, recovery, assets, preview]);
  const vars = { '--idp-primary': primary, '--idp-header': branding.headerColor || primary };
  const wrapper = { minHeight: preview ? 460 : '100vh', position: 'relative', overflow: 'hidden' };

  // The built-in page's background picture, behind the card. Blur spreads the picture past the edges so no blank border shows.
  const { logo, wordmark, background } = signInImages(branding, assets);
  const bgUrl = template ? '' : background;
  // A solid color chosen by the administrator replaces the theme color, and the text outside the card takes whichever of black and
  // white reads on it. Without a picture or a solid color, the page is a static color derived from the primary color.
  const solid = template || bgUrl ? '' : branding.loginBackgroundColor;
  const backdrop = bgUrl ? 'background.default' : solid || signInBackdrop(primary, mode);
  const textColor = solid ? bestText(solid) : 'text.primary';
  const blur = Number(branding.loginBackgroundBlur) || 0;
  const bgFilter = `blur(${blur}px) brightness(${branding.loginBackgroundBrightness ?? 100}%) contrast(${branding.loginBackgroundContrast ?? 100}%)`;

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

  // The built-in card look goes first, so the administrator's CSS, after it, overrides it.
  const style = DEFAULT_CARD_CSS + scopeCss(css, assets);
  const content = template ? (
    <form ref={form} onSubmit={submit} noValidate={preview}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </form>
  ) : (
    <Container maxWidth="xs" sx={{ py: preview ? 4 : 8, position: 'relative', zIndex: 1 }}>
      {/* With a background picture behind it, the card gets a soft shadow so it stands off the picture. */}
      <Card variant="outlined" className="idp-card" sx={bgUrl ? { boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)' } : undefined}>
        <CardContent>
          <Stack component="form" spacing={2} onSubmit={submit}>
            {logo && <Box className="idp-logo" component="img" src={logo} alt={branding.appName} sx={{ maxHeight: 64, maxWidth: '100%', alignSelf: 'flex-start', objectFit: 'contain' }} />}
            {!logo && wordmark && <Box className="idp-wordmark" component="img" src={wordmark} alt={branding.appName} sx={{ maxHeight: 48, maxWidth: '100%', alignSelf: 'flex-start', objectFit: 'contain' }} />}
            <Typography className="idp-title" variant="h5" component="h1">Sign in</Typography>
            {branding.loginMessage && <Typography className="idp-message" variant="body2" color="text.secondary">{branding.loginMessage}</Typography>}
            {error && <Alert className="idp-error" severity="error">{error}</Alert>}
            <TextField label="Username" name="username" autoComplete={preview ? 'off' : 'username'} autoFocus={!preview} required className="idp-field"
              defaultValue={defaults.username} slotProps={{ htmlInput: { id: 'username', ...(preview ? PREVIEW_IGNORE : {}) } }} />
            <TextField label="Password" name="password" type="password" autoComplete={preview ? 'off' : 'current-password'} required className="idp-field"
              slotProps={{ htmlInput: { id: 'password', ...(preview ? PREVIEW_IGNORE : {}) } }} />
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

  // The administrator's text: under the card (on a translucent panel, so it reads over a picture), or in a footer bar.
  const notice = branding.loginNotice || '';
  const barColor = branding.headerColor || primary;
  // The panel, text color and alignment are the administrator's choices. A link takes the text color.
  const noticeColor = branding.loginNoticeColor === 'black' ? '#000000' : '#ffffff';
  const belowCard = notice && branding.loginNoticePlacement !== 'footer' ? (
    <Box className="idp-notice" sx={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 444, mx: 'auto', px: 2, pb: 4, textAlign: branding.loginNoticeAlign || 'center' }}>
      <Box sx={{
        bgcolor: branding.loginNoticePanel === false ? 'transparent' : 'rgba(0, 0, 0, 0.5)', color: noticeColor, borderRadius: 2,
        px: branding.loginNoticePanel === false ? 0 : 2, py: branding.loginNoticePanel === false ? 0 : 1.5, '& a': { color: noticeColor },
      }}>
        <Markdown text={notice} />
      </Box>
    </Box>
  ) : null;
  const footerBar = notice && branding.loginNoticePlacement === 'footer' ? (
    <Box component="footer" className="idp-notice idp-footer" sx={{ position: 'relative', zIndex: 1, bgcolor: barColor, color: bestText(barColor), px: 2, py: 1.5, textAlign: 'center', '& a': { color: 'inherit' } }}>
      <Markdown text={notice} />
    </Box>
  ) : null;

  // The built-in card is centered in the space above the footer. A custom layout keeps its own layout.
  const mainSx = template ? { flex: 1 } : { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' };

  return (
    <Box className="idp-login" style={vars} sx={{ ...wrapper, bgcolor: backdrop, color: textColor, display: 'flex', flexDirection: 'column' }}>
      {bgUrl && (
        <div className="idp-bg" aria-hidden style={{
          position: 'absolute', inset: blur ? `-${blur * 2}px` : 0, zIndex: 0,
          backgroundImage: `url("${bgUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center', filter: bgFilter,
        }} />
      )}
      {style && <style>{style}</style>}
      <Box sx={mainSx}>
        <Box className={modeClass} sx={{ display: 'contents' }}>{content}</Box>
        {belowCard}
      </Box>
      {footerBar}
    </Box>
  );
}
