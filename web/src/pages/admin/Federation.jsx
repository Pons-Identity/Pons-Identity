import { useState } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import TabbedModule from '../../components/TabbedModule.jsx';
import { useCan } from '../../auth/permissions.js';
import FederationAlerts from './settings/federation/FederationAlerts.jsx';
import useIdentityForm from './settings/federation/useIdentityForm.js';
import SettingsTab from './settings/federation/SettingsTab.jsx';
import SigningTab from './settings/federation/SigningTab.jsx';
import ReleaseTab from './settings/federation/ReleaseTab.jsx';
import InstitutionsTab from './settings/federation/InstitutionsTab.jsx';

// The Federation module: joining an identity federation such as InCommon, through metadata sources, the federation identity and sign-in from other institutions.
// A tab appears only for administrators who may use it; every tab needs federation.view.
export default function Federation() {
  const can = useCan();
  if (!can('federation.view')) return <Alert severity="warning">You do not have permission to view federation.</Alert>;
  return <FederationModule />;
}

function FederationModule() {
  const can = useCan();
  const canManage = can('federation.manage');
  // Bumped when something the alerts depend on changes, so they are fetched again.
  const [rev, setRev] = useState(0);
  const changed = () => setRev((n) => n + 1);
  const identity = useIdentityForm({ onChanged: changed });

  const TABS = [
    { path: 'settings', label: 'Federation settings', permission: 'federation.view',
      element: <SettingsTab identity={identity} canManage={canManage} onChanged={changed} /> },
    { path: 'signing', label: 'Signing and encryption', permission: 'federation.view',
      element: <SigningTab identity={identity} canManage={canManage} /> },
    { path: 'release', label: 'Attribute release', permission: 'federation.view',
      element: <ReleaseTab identity={identity} canManage={canManage} /> },
    { path: 'institutions', label: 'Other institutions', permission: 'federation.view',
      element: <InstitutionsTab canManage={canManage} onChanged={changed} /> },
  ];

  return (
    <TabbedModule title="Federation" basePath="/admin/federation" tabs={TABS} ariaLabel="Federation sections"
      noAccess="You do not have permission to view federation."
      header={(
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Join an identity federation such as InCommon. Metadata sources supply the federation's service providers;
            the federation identity is how this server presents itself to them.
          </Typography>
          <FederationAlerts rev={rev} />
        </Stack>
      )} />
  );
}
