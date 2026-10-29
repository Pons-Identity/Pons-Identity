import { Divider, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import SourcesCard from './SourcesCard.jsx';
import EntitiesCard from './EntitiesCard.jsx';
import { Field, IdentityForm, Section } from './IdentityForm.jsx';

const CONTACTS = [['technical', 'Technical'], ['support', 'Support'], ['security', 'Security']];

// Where the federation's data comes from, and how this server presents itself to it.
export default function SettingsTab({ identity, canManage, onChanged }) {
  return (
    <Stack spacing={3}>
      <SourcesCard canManage={canManage} onChanged={onChanged} />
      <EntitiesCard />
      <IdentityForm identity={identity} canManage={canManage} label="Federation identity">
        <IdentitySection identity={identity} disabled={!canManage} />
      </IdentityForm>
    </Stack>
  );
}

function IdentitySection({ identity, disabled }) {
  const { view, cfg, set, setIn, setContact } = identity;
  return (
    <Section id="fed-identity" title="Federation identity"
      hint="One entity ID and one set of keys shared by every federation service provider. Applications you registered by hand keep their own identities.">
      <FormControlLabel label="Enable federation sign-in"
        control={<Switch checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={disabled} />} />
      <Field label="Entity ID" value={cfg.entityId} onChange={(v) => set({ entityId: v })} disabled={disabled} placeholder={view.defaultEntityId}
        helperText="Leave empty to use the default. Once registered with a federation, changing it means re-registering." />
      <Field label="Scope" value={cfg.scope} onChange={(v) => set({ scope: v })} disabled={disabled} placeholder="example.net"
        helperText="Your institution's domain. It is the right-hand side of eduPersonPrincipalName and scoped affiliations." />
      <Divider />
      <Typography variant="subtitle1" component="h3">Organization</Typography>
      <Field label="Organization name" value={cfg.organization.name} onChange={(v) => setIn('organization', 'name', v)} disabled={disabled} />
      <Field label="Organization display name" value={cfg.organization.displayName} onChange={(v) => setIn('organization', 'displayName', v)} disabled={disabled} />
      <Field label="Organization URL" value={cfg.organization.url} onChange={(v) => setIn('organization', 'url', v)} disabled={disabled} />
      <Typography variant="subtitle1" component="h3">Sign-in page information</Typography>
      <Field label="Display name" value={cfg.ui.displayName} onChange={(v) => setIn('ui', 'displayName', v)} disabled={disabled}
        helperText="Shown to people choosing where to sign in." />
      <Field label="Description" value={cfg.ui.description} onChange={(v) => setIn('ui', 'description', v)} disabled={disabled} />
      <Field label="Information URL" value={cfg.ui.informationUrl} onChange={(v) => setIn('ui', 'informationUrl', v)} disabled={disabled} />
      <Field label="Privacy statement URL" value={cfg.ui.privacyUrl} onChange={(v) => setIn('ui', 'privacyUrl', v)} disabled={disabled} />
      <Divider />
      <Typography variant="subtitle1" component="h3">Contacts</Typography>
      {CONTACTS.map(([kind, label]) => (
        <Stack key={kind} direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Field label={`${label} contact name`} value={cfg.contacts[kind].name} onChange={(v) => setContact(kind, 'name', v)} disabled={disabled} />
          <Field label={`${label} contact email`} value={cfg.contacts[kind].email} onChange={(v) => setContact(kind, 'email', v)} disabled={disabled} type="email" />
        </Stack>
      ))}
      <FormControlLabel label="Publish SIRTFI security incident response compliance"
        control={<Switch checked={cfg.sirtfi} onChange={(e) => set({ sirtfi: e.target.checked })} disabled={disabled} />} />
      <Typography variant="body2" color="text.secondary" sx={{ mt: '0 !important' }}>
        Only turn this on if your institution meets the SIRTFI framework. It needs the security contact above.
      </Typography>
    </Section>
  );
}
