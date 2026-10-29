import { Alert, AlertTitle, Checkbox, FormControlLabel, Stack } from '@mui/material';

// Warnings about settings that are allowed but dangerous. Each one that has not been accepted before has to be ticked before the
// page can be saved; the server refuses the save otherwise and sends the same list back (see security-settings.js).
// `warnings` is [{ id, title, message, acknowledged }]; `accepted` is the list of ids ticked on this page; `onChange` gets the new list.
export default function RiskAcknowledgement({ warnings, accepted, onChange }) {
  if (!warnings || !warnings.length) return null;
  const toggle = (id, on) => onChange(on ? [...accepted, id] : accepted.filter((x) => x !== id));
  return (
    <Stack spacing={2} aria-label="Security warnings">
      {warnings.map((w) => (
        <Alert key={w.id} severity="warning">
          <AlertTitle>{w.title}</AlertTitle>
          {w.message}
          <div>
            {w.acknowledged
              ? <FormControlLabel control={<Checkbox checked disabled />} label="This risk was accepted earlier. It will be asked about again if the setting is changed and then comes back." />
              : <FormControlLabel control={<Checkbox checked={accepted.includes(w.id)} onChange={(e) => toggle(w.id, e.target.checked)} />}
                label="I understand the risk and accept it" />}
          </div>
        </Alert>
      ))}
    </Stack>
  );
}
