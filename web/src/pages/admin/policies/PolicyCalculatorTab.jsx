import { useState } from 'react';
import { Alert, LinearProgress, Stack, Typography } from '@mui/material';
import CalculatorPicker from '../../../components/CalculatorPicker.jsx';
import CalculatorResult, { CalculatorError, useCalculation } from '../../../components/CalculatorResult.jsx';
import PageIntro from '../settings/PageIntro.jsx';
import { useCan } from '../../../auth/permissions.js';

const OUTCOME = {
  allowed: { severity: 'success', title: 'Allowed' },
  step_up: { severity: 'warning', title: 'Allowed after a second factor' },
  refused: { severity: 'error', title: 'Refused' },
};

// What a person trying an application would get, in one line above the detail.
function Outcome({ outcome, user, app }) {
  const o = OUTCOME[outcome.status];
  return (
    <Alert severity={o.severity}>
      <strong>{o.title}:</strong> {user} using {app}
      <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{outcome.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
    </Alert>
  );
}

/**
 * Policies → Policy calculator: pick a person, an application, or both, and see which policies are enforced, where each
 * winning rule comes from, and, for both, whether that person could use that application.
 */
export default function PolicyCalculatorTab() {
  const can = useCan();
  const [person, setPerson] = useState(null);
  const [app, setApp] = useState(null);
  const params = new URLSearchParams();
  if (person) params.set('user_id', person.id);
  if (app) { params.set('kind', app.kind); params.set('app_id', app.id); }
  const { result, error, loading } = useCalculation(person || app ? `/admin/calculators/policy?${params}` : null);

  return (
    <Stack spacing={3}>
      <PageIntro title="Policy calculator">
        Shows which policies are enforced in a situation. Choose a <strong>person</strong> to see the sign-in, password and compromised-account policies that apply
        to them and why; an <strong>application</strong> to see who may use it and which application policies cover it; or <strong>both</strong> to see
        what would happen when that person tries to use that application. Where policies disagree, the strictest value wins, and the result names the policies that set it.
      </PageIntro>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'flex-start' }}>
        <CalculatorPicker type="user" label="Person" value={person} onChange={setPerson} disabled={!can('users.view')}
          helperText={can('users.view') ? 'Optional. Name or username.' : 'You need permission to view people.'} />
        <CalculatorPicker type="app" label="Application" value={app} onChange={setApp} disabled={!can('sps.view')}
          helperText={can('sps.view') ? 'Optional. SAML, OpenID Connect, OAuth 2.0 or CAS.' : 'You need permission to view applications.'} />
      </Stack>
      {!person && !app && <Typography color="text.secondary">Choose a person, an application, or both.</Typography>}
      {loading && <LinearProgress aria-label="Calculating" />}
      <CalculatorError message={error} />
      {result && (
        <CalculatorResult result={result}
          summary={result.outcome ? <Outcome outcome={result.outcome} user={result.user.username} app={result.app.name} /> : null} />
      )}
    </Stack>
  );
}
