import { Box, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { BUILTIN_CLASSES, DEFAULT_CARD_CSS } from '../../../loginTemplate.js';
import { fontClass } from '../../../components/fontClass.js';

// Reference for writing the sign-in page: the fonts that can be used, the classes of the built-in page, and examples.

const Code = ({ children }) => (
  <Box component="pre" sx={{ m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontFamily: 'monospace', fontSize: 12, overflowX: 'auto', whiteSpace: 'pre' }}>
    {children}
  </Box>
);

// Every installed font (uploaded or from Google Fonts), with the family name and the class that sets it.
export function FontsReference({ fonts }) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Every installed font can be used in the page's CSS and HTML. Use the family name in CSS, or the class in HTML or CSS.
      </Typography>
      {fonts.length === 0 && <Typography variant="body2" color="text.secondary">No fonts are installed yet. Choose a system font above, or upload one.</Typography>}
      {fonts.length > 0 && (
        <Table size="small" aria-label="Fonts for the sign-in page">
          <TableHead><TableRow><TableCell>Font</TableCell><TableCell>Class</TableCell><TableCell>Family name in CSS</TableCell></TableRow></TableHead>
          <TableBody>
            {fonts.map((f) => (
              <TableRow key={f.family}>
                <TableCell>{f.family}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>.{fontClass(f.family)}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>font-family: &quot;{f.family}&quot;, sans-serif;</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {fonts.length > 0 && (
        <Code>{`/* In CSS: the family name */
.login-box h1 { font-family: "${fonts[0].family}", sans-serif; }

/* In CSS: the class */
.${fontClass(fonts[0].family)} input { font-family: inherit; }

<!-- In HTML: the class -->
<h1 class="${fontClass(fonts[0].family)}">Welcome</h1>`}</Code>
      )}
    </Box>
  );
}

// The built-in card in each mode, with the mode class it is in, so the administrator sees what .idp-light and .idp-dark do.
function ModeSamples() {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1.5 }}>
      <style>{DEFAULT_CARD_CSS}</style>
      {['light', 'dark'].map((mode) => (
        <Box key={mode} className="idp-login" sx={{ flex: 1, p: 2, borderRadius: 1, bgcolor: mode === 'dark' ? '#121212' : '#f1f4f9' }}>
          <Box className={`idp-${mode}`} sx={{ display: 'contents' }}>
            <Box className="idp-card" sx={{ p: 2, color: mode === 'dark' ? '#f5f5f5' : '#1a1a1a' }}>
              <Typography variant="subtitle1" component="p" sx={{ fontWeight: 'bold' }}>Sign in</Typography>
              <Typography variant="caption" component="p" sx={{ fontFamily: 'monospace' }}>.idp-{mode} .idp-card</Typography>
            </Box>
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

// The classes the built-in page draws its parts with, for the CSS.
export function ClassesReference() {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Style these in the custom CSS to change the built-in page. Hover a class in the CSS editor to see what it does.
      </Typography>
      <Table size="small" aria-label="Classes of the built-in sign-in page">
        <TableHead><TableRow><TableCell>Class</TableCell><TableCell>What it is</TableCell></TableRow></TableHead>
        <TableBody>
          {BUILTIN_CLASSES.map((c) => (
            <TableRow key={c.name}>
              <TableCell sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>.{c.name}</TableCell>
              <TableCell>{c.what}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, mb: 1 }}>
        The card is drawn in each mode. Style one mode with its class, or both at once; the mode class goes before the card.
      </Typography>
      <ModeSamples />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, mb: 1 }}>Colors are variables: var(--idp-primary) and var(--idp-header).</Typography>
      <Code>{`.idp-card { border-radius: 20px; }
.idp-submit { background: var(--idp-header); }
.idp-title { text-align: center; }

/* Dark mode only */
.idp-dark .idp-card { background-color: #1e1e1e; }`}</Code>
    </Box>
  );
}

// Examples of using uploaded images in the built-in page's CSS and in a custom layout's HTML and CSS.
export function ImageExamples({ name = 'background.png' }) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        An uploaded image is used by its file name. The background picture for the built-in page is set above; for your own layout, use:
      </Typography>
      <Code>{`<!-- Your own layout: an image in the HTML -->
<img src="${name}" alt="" class="my-picture">

/* Your own layout, or the built-in page: a picture behind everything */
& {
  background-image: url('${name}');
  background-size: cover;
  background-position: center;
}`}</Code>
    </Box>
  );
}
