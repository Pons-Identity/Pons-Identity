import { useEffect, useState } from 'react';
import { Alert, Autocomplete, Button, Card, CardContent, Stack, TextField } from '@mui/material';
import PageIntro from '../settings/PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';

// Which groups' members may host guests.
export default function GuestPoliciesTab() {
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);

  useEffect(() => { api('/admin/guest-policy').then(setForm).catch((e) => setErrors([e.message])); }, []);
  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  async function save() {
    setErrors([]);
    try {
      setForm(await api('/admin/guest-policy', { method: 'PUT', body: { hostGroups: form.hostGroups.map((g) => ({ id: g.id, maxGuests: Number(g.maxGuests) })), maxDays: Number(form.maxDays) } }));
      notify('Guest account policy saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    }
  }

  const chosen = form.groups.filter((g) => form.hostGroups.some((h) => h.id === g.id));
  const setLimit = (id, maxGuests) => setForm({ ...form, hostGroups: form.hostGroups.map((h) => (h.id === id ? { ...h, maxGuests } : h)) });
  return (
    <Stack spacing={3}>
      <PageIntro title="Guest account policies">
        Members of the groups chosen here (including through nested groups) may host guests: people who get their own sign-in, with no access
        until their host gives them roles. A guest can never do more than their host. Each group sets the most guests its members may have; someone in several groups gets the largest of their limits. With no group chosen, nobody can host guests. Someone who
        leaves every chosen group keeps the guests they have but cannot add or change them.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      <Card variant="outlined"><CardContent>
        <Autocomplete multiple options={form.groups} value={chosen} getOptionLabel={(g) => g.name} isOptionEqualToValue={(a, b) => a.id === b.id}
          onChange={(_, v) => setForm({ ...form, hostGroups: v.map((g) => form.hostGroups.find((h) => h.id === g.id) || { id: g.id, maxGuests: 25 }) })}
          renderInput={(params) => <TextField {...params} label="Groups whose members may host guests" />} />
        {chosen.map((g) => (
          <TextField key={g.id} type="number" label={`Most guests for members of ${g.name}`} value={form.hostGroups.find((h) => h.id === g.id).maxGuests}
            onChange={(e) => setLimit(g.id, e.target.value)} slotProps={{ htmlInput: { min: 1, max: 1000 } }} sx={{ display: 'block', mt: 2, maxWidth: 360 }} />
        ))}
        <TextField type="number" label="Longest a guest account may last (days)" value={form.maxDays} onChange={(e) => setForm({ ...form, maxDays: e.target.value })}
          slotProps={{ htmlInput: { min: 1, max: 3650 } }} sx={{ mt: 2, maxWidth: 360 }} helperText="Every guest account has an expiry time, and hosts cannot set one further away than this (14 days unless you change it)." />
      </CardContent></Card>
      <Button variant="contained" onClick={save} sx={{ alignSelf: 'flex-start' }}>Save</Button>
    </Stack>
  );
}
