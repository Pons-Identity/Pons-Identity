import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import AppShell from './layouts/AppShell.jsx';
import ErrorPage from './components/ErrorPage.jsx';
import Login from './pages/Login.jsx';
import LoginMfa from './pages/LoginMfa.jsx';
import LoginDuo from './pages/LoginDuo.jsx';
import FederatedLogin from './pages/FederatedLogin.jsx';
import MyGroups from './pages/MyGroups.jsx';
import MyGuests from './pages/MyGuests.jsx';
import MyGroup from './pages/MyGroup.jsx';
import Profile from './pages/Profile.jsx';
import Browsers from './pages/Browsers.jsx';
import Appearance from './pages/Appearance.jsx';
import Help from './pages/Help.jsx';
import RunIntegrations from './pages/RunIntegrations.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import Users from './pages/admin/Users.jsx';
import UserForm from './pages/admin/UserForm.jsx';
import BulkUsers from './pages/admin/BulkUsers.jsx';
import Recover from './pages/Recover.jsx';
import RecoverReset from './pages/RecoverReset.jsx';
import Approve from './pages/Approve.jsx';
import SignInLog from './pages/admin/SignInLog.jsx';
import Schedules from './pages/admin/Schedules.jsx';
import ServiceAccounts from './pages/admin/ServiceAccounts.jsx';
import Groups from './pages/admin/Groups.jsx';
import GroupCalculator from './pages/admin/GroupCalculator.jsx';
import Group from './pages/admin/Group.jsx';
import GroupForm from './pages/admin/GroupForm.jsx';
import Sps from './pages/admin/Sps.jsx';
import Sp from './pages/admin/Sp.jsx';
import ProtocolApp from './pages/admin/ProtocolApp.jsx';
import Settings from './pages/admin/Settings.jsx';
import Policies from './pages/admin/Policies.jsx';
import Federation from './pages/admin/Federation.jsx';
import Api from './pages/admin/Api.jsx';
import ExternalSystems from './pages/admin/ExternalSystems.jsx';
import Audit from './pages/admin/Audit.jsx';
import Integrations from './pages/admin/integrations/Integrations.jsx';
import RunPage from './pages/admin/integrations/RunPage.jsx';
import Reports from './pages/admin/reports/Reports.jsx';
import Setup from './pages/Setup.jsx';

function RequireAuth() {
  const { session } = useAuth();
  const location = useLocation();
  if (!session.me) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  // After an administrator enforced new password rules, the only page open is the one where the password is changed.
  if (session.me.password_change_required && location.pathname !== '/account/profile') {
    return <Navigate to={`/account/profile?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <Outlet />;
}

// The dashboard is the home page for administrators. Everyone else lands on the first page they can use.
function HomePage() {
  const { session } = useAuth();
  const me = session.me;
  if (me.is_admin) return <Dashboard />;
  return <Navigate to={me.manages_groups || me.self_service ? '/groups' : me.runs_integrations ? '/run' : '/account/profile'} replace />;
}

function RequireAdmin() {
  const { session } = useAuth();
  if (!session.me.is_admin) return <ErrorPage title="Forbidden" message="Administrator access is required." />;
  return <Outlet />;
}

export default function App() {
  const { session } = useAuth();
  const { pathname } = useLocation();
  // While nobody can sign in yet, every address leads to the setup wizard.
  if (session.setupRequired && !pathname.startsWith('/setup')) return <Navigate to="/setup" replace />;
  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route path="/login/mfa" element={<LoginMfa />} />
      <Route path="/login/duo" element={<LoginDuo />} />
      <Route path="/login/federation" element={<FederatedLogin />} />
      <Route path="/approve/:token" element={<Approve />} />
      <Route path="/recover" element={<Recover />} />
      <Route path="/recover/:token" element={<RecoverReset />} />
      <Route element={<RequireAuth />}>
        {/* A run's page is plain text on its own, without the console's header and menu. */}
        <Route element={<RequireAdmin />}>
          <Route path="/admin/integrations/:id/runs/:runId" element={<RunPage />} />
        </Route>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/admin" element={<Navigate to="/" replace />} />
          <Route path="/account/profile" element={<Profile />} />
          <Route path="/account/browsers" element={<Browsers />} />
          <Route path="/account/appearance" element={<Appearance />} />
          <Route path="/help" element={<Help />} />
          <Route path="/help/:slug" element={<Help />} />
          <Route path="/account/mfa" element={<Navigate to="/account/profile" replace />} />
          <Route path="/run" element={<RunIntegrations />} />
          <Route path="/groups" element={<MyGroups />} />
          <Route path="/guests" element={<MyGuests />} />
          <Route path="/groups/:id" element={<MyGroup />} />
          <Route element={<RequireAdmin />}>
            <Route path="/admin/users" element={<Users />} />
            <Route path="/admin/users/new" element={<UserForm />} />
            <Route path="/admin/users/import" element={<BulkUsers />} />
            <Route path="/admin/users/schedules" element={<Schedules />} />
            <Route path="/admin/users/service-accounts" element={<ServiceAccounts />} />
            <Route path="/admin/users/:id" element={<UserForm />} />
            <Route path="/admin/groups" element={<Groups />} />
            <Route path="/admin/groups/new" element={<GroupForm />} />
            <Route path="/admin/groups/calculator" element={<GroupCalculator />} />
            <Route path="/admin/groups/:id" element={<Group />} />
            <Route path="/admin/sps" element={<Sps />} />
            <Route path="/admin/sps/new" element={<Sp />} />
            <Route path="/admin/sps/:id" element={<Sp />} />
            <Route path="/admin/apps/new" element={<ProtocolApp />} />
            <Route path="/admin/apps/:id" element={<ProtocolApp />} />
            <Route path="/admin/integrations/*" element={<Integrations />} />
            <Route path="/admin/reports/*" element={<Reports />} />
            <Route path="/admin/audit" element={<Audit />} />
            <Route path="/admin/sign-ins" element={<SignInLog />} />
            <Route path="/admin/policies/*" element={<Policies />} />
            {/* Policies used to be tabs of Settings; these keep old links working. */}
            <Route path="/admin/settings/policies" element={<Navigate to="/admin/policies/sign-in" replace />} />
            <Route path="/admin/settings/app-policies" element={<Navigate to="/admin/policies/applications" replace />} />
            <Route path="/admin/settings/password-policies" element={<Navigate to="/admin/policies/passwords" replace />} />
            {/* Federation used to be a tab of Settings; this keeps old links working. */}
            <Route path="/admin/settings/federation" element={<Navigate to="/admin/federation" replace />} />
            <Route path="/admin/federation/*" element={<Federation />} />
            {/* The APIs and external systems used to be tabs of Settings; these keep old links working. */}
            <Route path="/admin/settings/group-api" element={<Navigate to="/admin/api/group-api" replace />} />
            <Route path="/admin/settings/user-api" element={<Navigate to="/admin/api/user-api" replace />} />
            <Route path="/admin/settings/grouper" element={<Navigate to="/admin/external-systems/grouper" replace />} />
            <Route path="/admin/settings/directories" element={<Navigate to="/admin/external-systems/directories" replace />} />
            <Route path="/admin/settings/radius" element={<Navigate to="/admin/external-systems/radius" replace />} />
            <Route path="/admin/settings/duo" element={<Navigate to="/admin/external-systems/duo" replace />} />
            <Route path="/admin/api/*" element={<Api />} />
            <Route path="/admin/external-systems/*" element={<ExternalSystems />} />
            <Route path="/admin/settings/*" element={<Settings />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<ErrorPage title="Not found" message="Page not found." />} />
    </Routes>
  );
}
