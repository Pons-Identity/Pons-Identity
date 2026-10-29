import TabbedModule from '../../components/TabbedModule.jsx';
import GrouperTab from './settings/GrouperTab.jsx';
import DirectoriesTab from './settings/DirectoriesTab.jsx';
import RadiusTab from './settings/RadiusTab.jsx';
import DuoTab from './settings/DuoTab.jsx';

// The External systems module: other systems that provision groups and users into this IdP, or that authenticate through it.
// A tab appears only for administrators who may manage it.
const TABS = [
  { path: 'grouper', label: 'Grouper', permission: 'grouper.manage', element: <GrouperTab /> },
  { path: 'directories', label: 'Directories', permission: 'directories.manage', element: <DirectoriesTab /> },
  { path: 'radius', label: 'RADIUS', permission: 'radius.manage', element: <RadiusTab /> },
  { path: 'duo', label: 'Duo MFA', permission: 'duo.manage', element: <DuoTab /> },
];

export default function ExternalSystems() {
  return (
    <TabbedModule title="External systems" basePath="/admin/external-systems" tabs={TABS} ariaLabel="External system types"
      noAccess="You do not have permission to manage external systems." />
  );
}
