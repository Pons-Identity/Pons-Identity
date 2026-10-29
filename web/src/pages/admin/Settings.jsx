import TabbedModule from '../../components/TabbedModule.jsx';
import RolesTab from './settings/RolesTab.jsx';
import BrandingTab from './settings/BrandingTab.jsx';
import LoginPageTab from './settings/LoginPageTab.jsx';
import AttributesTab from './settings/AttributesTab.jsx';
import FactorsTab from './settings/FactorsTab.jsx';
import RecoveryTab from './settings/RecoveryTab.jsx';
import RiskTab from './settings/RiskTab.jsx';
import MessagingTab from './settings/MessagingTab.jsx';
import MessageTemplatesTab from './settings/MessageTemplatesTab.jsx';
import AuditForwardingTab from './settings/AuditForwardingTab.jsx';
import IdentityTab from './settings/IdentityTab.jsx';
import SessionTab from './settings/SessionTab.jsx';
import MigrationTab from './settings/MigrationTab.jsx';
import ExportTab from './settings/ExportTab.jsx';
import SetupTab from './settings/SetupTab.jsx';

// One tab per settings category. Policies, federation, the APIs and external systems (including Duo MFA) have their own modules (Policies.jsx, Federation.jsx, Api.jsx, ExternalSystems.jsx).
const TABS = [
  { path: 'roles', label: 'Roles & permissions', permission: 'roles.view', element: <RolesTab /> },
  { path: 'attributes', label: 'User attributes', permission: 'attributes.manage', element: <AttributesTab /> },
  { path: 'factors', label: 'Sign-in factors', permission: 'factors.manage', element: <FactorsTab /> },
  { path: 'sessions', label: 'Sessions', permission: 'sessions.manage', element: <SessionTab /> },
  { path: 'recovery', label: 'Password recovery', permission: 'recovery.manage', element: <RecoveryTab /> },
  { path: 'identity', label: 'Identity verification', permission: 'recovery.manage', element: <IdentityTab /> },
  { path: 'risk', label: 'Risk-based authentication', permission: 'risk.manage', element: <RiskTab /> },
  { path: 'messaging', label: 'Messaging', permission: 'messaging.manage', element: <MessagingTab /> },
  { path: 'message-templates', label: 'Message templates', permission: 'messaging.manage', element: <MessageTemplatesTab /> },
  { path: 'log-forwarding', label: 'Log forwarding', permission: 'audit.manage', element: <AuditForwardingTab /> },
  { path: 'branding', label: 'Branding', permission: 'branding.manage', element: <BrandingTab /> },
  { path: 'login-page', label: 'Sign-in page', permission: 'branding.manage', element: <LoginPageTab /> },
  { path: 'migration', label: 'Migration', permission: 'migration.manage', element: <MigrationTab /> },
  { path: 'export', label: 'Export', permission: 'export.manage', element: <ExportTab /> },
  { path: 'setup', label: 'Setup wizard', permission: 'setup.run', element: <SetupTab /> },
];

export default function Settings() {
  return (
    <TabbedModule title="Settings" basePath="/admin/settings" tabs={TABS} ariaLabel="Settings categories"
      noAccess="You do not have permission to change any settings." />
  );
}
