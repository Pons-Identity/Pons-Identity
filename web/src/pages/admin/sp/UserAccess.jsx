import { Autocomplete, Card, CardContent, FormControlLabel, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';

const MODES = [
  { value: 'none', label: 'Disabled for all users' },
  { value: 'groups', label: 'Enabled for certain groups' },
  { value: 'all', label: 'Enabled for all users' },
];

export default function UserAccess({ form, set, opts }) {
  const selected = opts.groups.filter((g) => form.access_groups.includes(String(g.id)));
  return (
    <Card variant="outlined" component="section" aria-labelledby="user-access">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" id="user-access">User access</Typography>
          <RadioGroup aria-labelledby="user-access" value={form.access_mode} onChange={(e) => set('access_mode', e.target.value)}>
            {MODES.map((m) => <FormControlLabel key={m.value} value={m.value} label={m.label} control={<Radio />} />)}
          </RadioGroup>
          {form.access_mode === 'groups' && (
            <Autocomplete multiple options={opts.groups} value={selected} getOptionLabel={(g) => g.name}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              onChange={(_, v) => set('access_groups', v.map((g) => String(g.id)))}
              renderInput={(params) => (
                <TextField {...params} label="Groups with access"
                  helperText="Only members of these groups can sign in to this application." />)} />
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
