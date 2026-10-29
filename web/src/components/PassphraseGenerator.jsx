import { useEffect, useState } from 'react';
import { Box, Button, Checkbox, FormControlLabel, Stack, TextField, Typography } from '@mui/material';

// Kept here, not imported from passphrase.js, so the word list stays out of the main bundle until the panel opens.
const WORDS = { min: 3, max: 8 };
const SEPARATOR_MAX = 3;
const DEFAULTS = { words: 4, separator: '-', capitalize: true, includeNumber: true };
const clamp = (v) => Math.min(WORDS.max, Math.max(WORDS.min, Math.round(Number(v)) || WORDS.min));

// Offers a random passphrase with a few options, and hands the one the person accepts to `onUse`. The word list loads the
// first time the panel opens, so the password forms do not pay for it otherwise.
export default function PassphraseGenerator({ onUse }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(DEFAULTS);
  const [generate, setGenerate] = useState(null);
  const [phrase, setPhrase] = useState('');

  useEffect(() => {
    if (open && !generate) import('../passphrase.js').then((m) => setGenerate(() => m.generatePassphrase));
  }, [open, generate]);

  // A new phrase whenever the options change, so the preview always matches them.
  useEffect(() => {
    if (generate) setPhrase(generate({ ...options, words: clamp(options.words) }));
  }, [generate, options]);

  const accept = () => {
    onUse(phrase);
    setOpen(false);
  };

  return (
    <Box>
      <Button size="small" onClick={() => setOpen((o) => !o)} aria-expanded={open} sx={{ alignSelf: 'flex-start' }}>
        {open ? 'Hide passphrase generator' : 'Generate a passphrase'}
      </Button>
      {open && (
        <Stack spacing={2} sx={{ mt: 1, p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Typography variant="body2" color="text.secondary">
            A passphrase of random words is easier to type than a random string and harder to guess. Four words or more is a good choice.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <TextField label="Words" type="number" size="small" value={options.words} sx={{ width: 110 }}
              onChange={(e) => setOptions({ ...options, words: e.target.value })}
              onBlur={() => setOptions((o) => ({ ...o, words: clamp(o.words) }))}
              slotProps={{ htmlInput: { min: WORDS.min, max: WORDS.max } }} />
            <TextField label="Separator" size="small" value={options.separator} sx={{ width: 130 }}
              onChange={(e) => setOptions({ ...options, separator: e.target.value.slice(0, SEPARATOR_MAX) })}
              helperText={`Up to ${SEPARATOR_MAX} characters, or none.`} />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0} sx={{ color: 'text.secondary' }}>
            <FormControlLabel label="Capital letters" control={<Checkbox checked={options.capitalize}
              onChange={(e) => setOptions({ ...options, capitalize: e.target.checked })} />} />
            <FormControlLabel label="Include a number" control={<Checkbox checked={options.includeNumber}
              onChange={(e) => setOptions({ ...options, includeNumber: e.target.checked })} />} />
          </Stack>
          <Typography role="status" aria-live="polite" aria-label="Generated passphrase"
            sx={{ fontFamily: 'monospace', fontSize: 16, wordBreak: 'break-all', minHeight: 24 }}>
            {phrase || 'Loading…'}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={() => setPhrase(generate({ ...options, words: clamp(options.words) }))} disabled={!generate}>Regenerate</Button>
            <Button variant="contained" onClick={accept} disabled={!phrase}>Use this passphrase</Button>
          </Stack>
        </Stack>
      )}
    </Box>
  );
}
