import { Divider, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import RepeaterRows from '../../../../components/RepeaterRows.jsx';
import { useCan } from '../../../../auth/permissions.js';
import ReleasePreview from './ReleasePreview.jsx';
import { Choice, IdentityForm, Section } from './IdentityForm.jsx';

// Which attributes go to federation service providers, and where their values come from.
export default function ReleaseTab({ identity, canManage }) {
  const can = useCan();
  return (
    <Stack spacing={3}>
      <IdentityForm identity={identity} canManage={canManage} label="Attribute release">
        <ReleaseSection identity={identity} disabled={!canManage} />
      </IdentityForm>
      {canManage && can('users.view') && <ReleasePreview />}
    </Stack>
  );
}

function ReleaseSection({ identity, disabled }) {
  const { view, cfg, set, setIn } = identity;
  return (
    <Section id="fed-release" title="Attribute release"
      hint="Nothing is sent to a service provider unless one of the categories below applies to it or it marks the attribute as required.">
      {view.categories.map((c) => (
        <div key={c.id}>
          <FormControlLabel label={c.label}
            control={<Switch checked={Boolean(cfg.categories[c.id])} disabled={disabled}
              onChange={(e) => setIn('categories', c.id, e.target.checked)} />} />
          <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 6, mt: -0.5, wordBreak: 'break-all' }}>
            {c.uri}{c.requestedOnly ? '. Releases the attributes the service provider requests.' : ''}
          </Typography>
        </div>
      ))}
      <FormControlLabel label="Release attributes a service provider marks as required"
        control={<Switch checked={cfg.releaseRequired} onChange={(e) => set({ releaseRequired: e.target.checked })} disabled={disabled} />} />
      <Divider />
      <Typography variant="subtitle1" component="h3">Identity values</Typography>
      <Choice label="eduPersonPrincipalName comes from" value={cfg.eppnSource} onChange={(v) => set({ eppnSource: v })} disabled={disabled}
        options={view.eppnSources.map((s) => ({ value: s, label: s }))} helperText="The part before @ is used; the scope above is appended." />
      <Choice label="Default affiliation" value={cfg.defaultAffiliation} onChange={(v) => set({ defaultAffiliation: v })} disabled={disabled}
        options={[{ value: '', label: 'None' }, ...view.affiliations.map((a) => ({ value: a, label: a }))]}
        helperText="Used for people who are in none of the groups below." />
      <Typography variant="subtitle2" component="h3">Affiliation by group</Typography>
      {disabled ? cfg.affiliationGroups.map((r) => <Typography key={r.group} variant="body2">{r.group} → {r.affiliation}</Typography>) : (
        <RepeaterRows rows={cfg.affiliationGroups} onChange={(rows) => set({ affiliationGroups: rows })}
          emptyRow={{ group: '', affiliation: 'member' }} addLabel="Add affiliation mapping"
          fields={[{ key: 'group', label: 'Group name' }, { key: 'affiliation', label: 'Affiliation', options: view.affiliations.map((a) => ({ value: a, label: a })) }]} />
      )}
    </Section>
  );
}
