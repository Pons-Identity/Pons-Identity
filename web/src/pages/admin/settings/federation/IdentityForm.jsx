import { Alert, Button, Card, CardContent, MenuItem, Stack, TextField, Typography } from '@mui/material';

// A card with a heading, for one group of settings on a Federation tab.
export function Section({ id, title, children, hint }) {
  return (
    <Card variant="outlined" component="section" aria-labelledby={id}>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" id={id}>{title}</Typography>
          {hint && <Typography variant="body2" color="text.secondary">{hint}</Typography>}
          {children}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function Field({ label, value, onChange, disabled, ...props }) {
  return <TextField fullWidth label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} {...props} />;
}

export function Choice({ label, value, onChange, disabled, options, helperText }) {
  return (
    <TextField select fullWidth label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} helperText={helperText}>
      {options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );
}

// The one form behind the identity tabs: a single save sends the whole federation identity. Its sections render only once the settings are loaded.
export function IdentityForm({ identity, canManage, label, children }) {
  const { cfg, errors, saving, save } = identity;
  if (!cfg) return errors.length ? <Alert severity="error">{errors.join(' ')}</Alert> : null;
  return (
    <Stack component="form" spacing={3} onSubmit={save} aria-label={label}>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      {children}
      {canManage && <Button type="submit" variant="contained" disabled={saving} sx={{ alignSelf: 'flex-start' }}>Save federation settings</Button>}
    </Stack>
  );
}
