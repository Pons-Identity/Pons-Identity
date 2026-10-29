import { useEffect, useState } from 'react';
import { Box, LinearProgress, Typography } from '@mui/material';

export const SCORE_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
const COLORS = ['error', 'error', 'warning', 'success', 'success'];

// The dictionaries are large, so they load the first time a strength meter is shown rather than with the app. The server runs the same
// library and is what actually refuses a weak password; this only tells the person how they are doing.
let checker = null;
const loadChecker = () => {
  checker ||= Promise.all([import('@zxcvbn-ts/core'), import('@zxcvbn-ts/language-common'), import('@zxcvbn-ts/language-en')])
    .then(([core, common, en]) => new core.ZxcvbnFactory({
      translations: en.translations, graphs: common.adjacencyGraphs, dictionary: { ...common.dictionary, ...en.dictionary },
    }));
  return checker;
};

/** A bar and a word (Very weak … Strong) for `password`. `userInputs` are words to treat as guessable, e.g. the username. */
export default function PasswordStrength({ password, userInputs = [], minScore = 0 }) {
  const [result, setResult] = useState(null);
  const inputs = userInputs.join('\n');

  useEffect(() => {
    let current = true;
    if (!password) { setResult(null); return undefined; }
    loadChecker().then((z) => {
      if (current) setResult(z.check(password.slice(0, 256), inputs ? inputs.split('\n') : []));
    });
    return () => { current = false; };
  }, [password, inputs]);

  if (!password || !result) return null;
  const { score, feedback } = result;
  const short = score < minScore;
  const hint = feedback.warning || feedback.suggestions?.[0] || '';
  return (
    <Box>
      <LinearProgress variant="determinate" value={(score + 1) * 20} color={COLORS[score]} aria-label="Password strength" aria-valuetext={SCORE_LABELS[score]}
        sx={{ height: 8, borderRadius: 4 }} />
      <Typography variant="caption" color={short ? 'error' : 'text.secondary'} component="p" aria-live="polite" sx={{ mt: 0.5 }}>
        <strong>{SCORE_LABELS[score]}</strong>
        {short ? ` — ${SCORE_LABELS[minScore].toLowerCase()} or better is required.` : ''}
        {hint ? ` ${hint}` : ''}
      </Typography>
    </Box>
  );
}

/** The password rules that apply (from /account/password-rules or /admin/users/:id/password-rules), then the strength meter when on. */
export function PasswordGuidance({ rules, password, userInputs }) {
  if (!rules) return null;
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="p">Your password must meet these rules:</Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5, color: 'text.secondary', typography: 'caption' }}>
        {rules.requirements.map((r) => <li key={r}>{r}</li>)}
      </Box>
      {rules.strength && <Box sx={{ mt: 1 }}><PasswordStrength password={password} userInputs={userInputs} minScore={rules.strength.min_score} /></Box>}
    </Box>
  );
}
