import TabbedModule from '../../components/TabbedModule.jsx';
import PoliciesTab from './policies/PoliciesTab.jsx';
import AppPoliciesTab from './policies/AppPoliciesTab.jsx';
import PasswordPoliciesTab from './policies/PasswordPoliciesTab.jsx';
import CompromisePoliciesTab from './policies/CompromisePoliciesTab.jsx';
import GuestPoliciesTab from './policies/GuestPoliciesTab.jsx';
import PolicyCalculatorTab from './policies/PolicyCalculatorTab.jsx';

// The Policies module: sign-in rules, application rules, password rules, compromised-account rules, guest-account rules (who may host guests, how many, for how long), and a calculator that shows which of them are enforced for a person or application. A tab appears only for administrators who may view policies.
const TABS = [
  { path: 'sign-in', label: 'Sign-in policies', permission: 'policies.view', element: <PoliciesTab /> },
  { path: 'applications', label: 'Application policies', permission: 'policies.view', element: <AppPoliciesTab /> },
  { path: 'passwords', label: 'Password policies', permission: 'policies.view', element: <PasswordPoliciesTab /> },
  { path: 'compromised', label: 'Compromised account policies', permission: 'policies.view', element: <CompromisePoliciesTab /> },
  { path: 'guests', label: 'Guest account policies', permission: 'policies.view', element: <GuestPoliciesTab /> },
  { path: 'calculator', label: 'Policy calculator', permission: 'policies.view', element: <PolicyCalculatorTab /> },
];

export default function Policies() {
  return (
    <TabbedModule title="Policies" basePath="/admin/policies" tabs={TABS} ariaLabel="Policy types"
      noAccess="You do not have permission to view policies." />
  );
}
