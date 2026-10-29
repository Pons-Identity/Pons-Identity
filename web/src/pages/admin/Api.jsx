import TabbedModule from '../../components/TabbedModule.jsx';
import GroupApiTab from './settings/GroupApiTab.jsx';
import UserApiTab from './settings/UserApiTab.jsx';

// The API module: the tokens and switches for the Group API and the User API. A tab appears only for administrators who may manage it.
const TABS = [
  { path: 'group-api', label: 'Group API', permission: 'groupapi.manage', element: <GroupApiTab /> },
  { path: 'user-api', label: 'User API', permission: 'userapi.manage', element: <UserApiTab /> },
];

export default function Api() {
  return (
    <TabbedModule title="API" basePath="/admin/api" tabs={TABS} ariaLabel="API types"
      noAccess="You do not have permission to manage the APIs." />
  );
}
