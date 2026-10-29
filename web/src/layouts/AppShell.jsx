import { useEffect, useState } from 'react';
import { AppBar, Box, Button, Container, Divider, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Toolbar, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PeopleIcon from '@mui/icons-material/People';
import GroupsIcon from '@mui/icons-material/Groups';
import AppsIcon from '@mui/icons-material/Apps';
import ExtensionIcon from '@mui/icons-material/Extension';
import AssessmentIcon from '@mui/icons-material/Assessment';
import HistoryIcon from '@mui/icons-material/History';
import LoginIcon from '@mui/icons-material/Login';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import LogoutIcon from '@mui/icons-material/Logout';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';
import PolicyIcon from '@mui/icons-material/Policy';
import ApiIcon from '@mui/icons-material/Api';
import DeviceHubIcon from '@mui/icons-material/DeviceHub';
import HubIcon from '@mui/icons-material/Hub';
import DevicesIcon from '@mui/icons-material/Devices';
import PaletteIcon from '@mui/icons-material/Palette';
import { Link as RouterLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useCan } from '../auth/permissions.js';
import GlobalSearch from '../components/GlobalSearch.jsx';
import { brandImages } from '../components/brandImages.js';
import BrandHeading from '../components/BrandHeading.jsx';

// Each item shows only when the user holds the permission that page needs.
const ADMIN_LINKS = [
  { to: '/', label: 'Dashboard', icon: DashboardIcon, description: 'Counts and alerts' },
  { to: '/admin/users', label: 'Users', icon: PeopleIcon, description: 'Accounts and imports', permission: 'users.view' },
  { to: '/admin/groups', label: 'Groups', icon: GroupsIcon, description: 'Groups and folders', permission: 'groups.view' },
  { to: '/admin/sps', label: 'Applications', icon: AppsIcon, description: 'SAML, CAS, OIDC and OAuth', permission: 'sps.view', aliases: ['/admin/apps'] },
  { to: '/admin/integrations', label: 'Integrations', icon: ExtensionIcon, description: 'Event and scheduled automations', permission: 'integrations.view' },
  { to: '/admin/reports', label: 'Reports', icon: AssessmentIcon, description: 'Users, groups and sign-ins', permission: 'reports.view' },
  { to: '/admin/audit', label: 'Audit log', icon: HistoryIcon, description: 'Administrative change history', permission: 'audit.view' },
  { to: '/admin/sign-ins', label: 'Sign-in log', icon: LoginIcon, description: 'Sign-in history', permission: 'audit.view' },
  { to: '/admin/policies', label: 'Policies', icon: PolicyIcon, description: 'Sign-in, app and password rules', permission: 'policies.view' },
  { to: '/admin/federation', label: 'Federation', icon: HubIcon, description: 'InCommon and other federations', permission: 'federation.view' },
  { to: '/admin/api', label: 'API', icon: ApiIcon, description: 'Group and User API tokens', permission: ['groupapi.manage', 'userapi.manage'] },
  { to: '/admin/external-systems', label: 'External systems', icon: DeviceHubIcon, description: 'Grouper, directories, RADIUS and Duo MFA', permission: ['grouper.manage', 'directories.manage', 'radius.manage', 'duo.manage'] },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon, description: 'Factors, messaging and branding', permission: ['roles.view', 'branding.manage', 'messaging.manage', 'factors.manage', 'recovery.manage', 'attributes.manage', 'risk.manage'] },
];

// The Dashboard (the home page) lives at exactly /; every other module owns its path and sub-paths.
function isCurrentModule(link, pathname) {
  return [link.to, ...(link.aliases || [])].some((to) => (to === '/' ? pathname === '/' : pathname.startsWith(to)));
}

// Signed-in chrome: replaces views/_head.ejs and views/_foot.ejs.
export default function AppShell() {
  const { session } = useAuth();
  const me = session.me;
  const can = useCan();
  const location = useLocation();
  const { appName } = session.branding;
  const { logo, wordmark } = brandImages(session.branding);
  const links = ADMIN_LINKS.filter((l) => !l.permission || [].concat(l.permission).some(can));
  const currentModule = ADMIN_LINKS.find((l) => isCurrentModule(l, location.pathname));
  const CurrentModuleIcon = currentModule?.icon;
  const [searching, setSearching] = useState(false);
  const [adminMenu, setAdminMenu] = useState(null);
  const [profileMenu, setProfileMenu] = useState(null);

  // Ctrl+K or ⌘K opens search from anywhere in the console.
  useEffect(() => {
    if (!me.is_admin) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [me.is_admin]);

  // A new page starts at the top, not at wherever the previous one was scrolled.
  useEffect(() => {
    window.scrollTo?.({ top: 0 });
  }, [location.pathname]);

  return (
    <>
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ gap: 1, flexWrap: 'wrap', py: 1 }}>
          <Stack component={RouterLink} to="/" direction="row" alignItems="center" spacing={1} sx={{ textDecoration: 'none', color: 'inherit', mr: 2 }}>
            <BrandHeading appName={appName} logo={logo} wordmark={wordmark} />
          </Stack>
          {me.is_admin && (
            <>
              <Button color="inherit" startIcon={CurrentModuleIcon && <CurrentModuleIcon />} endIcon={<ExpandMoreIcon />} aria-haspopup="menu" aria-controls="admin-menu" aria-expanded={Boolean(adminMenu)} onClick={(e) => setAdminMenu(e.currentTarget)}>
                {currentModule ? currentModule.label : 'Modules'}
              </Button>
              <Menu id="admin-menu" anchorEl={adminMenu} open={Boolean(adminMenu)} onClose={() => setAdminMenu(null)} slotProps={{ paper: { sx: { width: 'max-content', maxWidth: '100vw' } } }}>
                {links.map((l) => {
                  const Icon = l.icon;
                  const current = isCurrentModule(l, location.pathname);
                  return (
                    <MenuItem key={l.to} component={RouterLink} to={l.to} selected={current} onClick={() => setAdminMenu(null)} sx={{ alignItems: 'flex-start', py: 1 }}>
                      <ListItemIcon sx={{ mt: 0.5 }}><Icon fontSize="small" /></ListItemIcon>
                      <ListItemText primary={l.label} secondary={l.description} secondaryTypographyProps={{ variant: 'body2' }} />
                    </MenuItem>
                  );
                })}
              </Menu>
            </>
          )}
          <Box sx={{ flexGrow: 1 }} />
          {me.is_admin && (
            <Button color="inherit" startIcon={<SearchIcon />} onClick={() => setSearching(true)} aria-label="Search the console (Ctrl+K)" aria-keyshortcuts="Control+K Meta+K" sx={{ textTransform: 'none' }}>
              Search
            </Button>
          )}
          {(me.manages_groups || me.self_service) && <Button component={RouterLink} to="/groups" color="inherit">My groups</Button>}
          {me.runs_integrations && <Button component={RouterLink} to="/run" color="inherit">Run an integration</Button>}
          <Button component={RouterLink} to="/help" color="inherit" startIcon={<HelpOutlineIcon />} sx={{ textTransform: 'none' }}>Help</Button>
          <Button color="inherit" endIcon={<ExpandMoreIcon />} aria-haspopup="menu" aria-controls="profile-menu" aria-expanded={Boolean(profileMenu)} onClick={(e) => setProfileMenu(e.currentTarget)} sx={{ textTransform: 'none', ml: 1 }}>
            {me.display_name || me.username}
          </Button>
          <Menu id="profile-menu" anchorEl={profileMenu} open={Boolean(profileMenu)} onClose={() => setProfileMenu(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
            <MenuItem component={RouterLink} to="/account/profile" onClick={() => setProfileMenu(null)}>
              <ListItemIcon><PersonIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary="Profile" />
            </MenuItem>
            {me.hosts_guests && (
              <MenuItem component={RouterLink} to="/guests" onClick={() => setProfileMenu(null)}>
                <ListItemIcon><GroupAddIcon fontSize="small" /></ListItemIcon>
                <ListItemText primary="Guest accounts" />
              </MenuItem>
            )}
            <MenuItem component={RouterLink} to="/account/browsers" onClick={() => setProfileMenu(null)}>
              <ListItemIcon><DevicesIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary="Browsers and activity" />
            </MenuItem>
            <MenuItem component={RouterLink} to="/account/appearance" onClick={() => setProfileMenu(null)}>
              <ListItemIcon><PaletteIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary="Color theme" />
            </MenuItem>
            <Divider />
            <MenuItem component="button" type="submit" form="logout-form" sx={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }}>
              <ListItemIcon><LogoutIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary="Sign out" />
            </MenuItem>
          </Menu>
          <form id="logout-form" method="post" action="/logout" hidden>
            <input type="hidden" name="_csrf" value={session.csrf} />
          </form>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Outlet />
      </Container>
      {me.is_admin && <GlobalSearch open={searching} onClose={() => setSearching(false)} />}
    </>
  );
}
