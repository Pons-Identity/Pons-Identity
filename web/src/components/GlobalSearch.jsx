import { LdapQueryButton } from './LdapQueryBuilder.jsx';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Dialog, InputAdornment, List, ListItemButton, ListItemText, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { api } from '../api/client.js';
import { DEFAULT_PRODUCT_NAME, useAuth, useProductName } from '../auth/AuthContext.jsx';
import { useCan } from '../auth/permissions.js';
import { visibleArticles } from '../help/articles.js';
import { searchArticles } from '../help/search.js';
import { PROTOCOLS } from '../pages/admin/app/appForm.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Each section: its title, the list page "See all" opens (searched with the same text), and how a match is shown and where it leads.
const SECTIONS = [
  {
    key: 'people', title: 'People', list: '/admin/users',
    row: (p) => ({ to: `/admin/users/${p.id}`, label: p.display_name || p.username, detail: [p.username, p.email, p.department].filter(Boolean).join(' · ') }),
  },
  {
    key: 'applications', title: 'Applications', list: '/admin/sps',
    row: (a) => ({ to: a.to, label: a.name, detail: [PROTOCOLS[a.protocol]?.label, a.identifier].filter(Boolean).join(' · ') }),
  },
  {
    key: 'groups', title: 'Groups', list: '/admin/groups',
    row: (g) => ({ to: `/admin/groups/${g.id}`, label: g.name, detail: g.description || plural(g.member_count, 'member') }),
  },
  {
    key: 'integrations', title: 'Integrations', list: '/admin/integrations',
    row: (i) => ({ to: `/admin/integrations/${i.id}`, label: i.name, detail: i.description }),
  },
  {
    key: 'audit', title: 'Audit log', list: '/admin/audit',
    row: (e, q) => ({ to: `/admin/audit?q=${encodeURIComponent(q)}`, label: e.action, detail: [new Date(e.ts * 1000).toLocaleString(), e.actor_name, e.target_name].filter(Boolean).join(' · ') }),
  },
  {
    key: 'docs', title: 'Documentation', list: '/help',
    row: (a, q, name) => ({ to: `/help/${a.slug}`, label: a.title.replaceAll(DEFAULT_PRODUCT_NAME, name), detail: a.summary.replaceAll(DEFAULT_PRODUCT_NAME, name) }),
  },
];

/**
 * The Search button's dialog. The page behind it is dimmed and blurred, and the search sits at the top, as in Spotlight.
 * Only the sections the server returns are shown, so people see matches only in areas they can open.
 */
export default function GlobalSearch({ open, onClose }) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const productName = useProductName();
  const can = useCan();
  const [text, setText] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const q = text.trim();

  // Start fresh each time the dialog opens.
  useEffect(() => {
    if (open) {
      setText('');
      setData(null);
      setError('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let stale = false;
    const timer = setTimeout(() => {
      if (q.length < 2) {
        setData(null);
        return;
      }
      api(`/admin/search?${new URLSearchParams({ q })}`)
        .then((d) => { if (!stale) { setData(d); setError(''); setActive(0); } })
        .catch((e) => { if (!stale) setError(e.message); });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, q]);

  // Documentation is in the console's own bundle, so it is searched here, among the articles the person may read.
  const docs = q.length >= 2 ? searchArticles(visibleArticles({ can, me: session.me }), q) : null;
  const blocks = { ...data, ...(docs && { docs }) };

  // Each result, numbered down the whole list so the arrow keys can move through sections.
  const sections = SECTIONS.filter((s) => blocks[s.key]).map((s) => ({ ...s, block: blocks[s.key] }));
  const flat = sections.flatMap((s) => s.block.results.map((r) => ({ section: s.key, ...s.row(r, q, productName) })));

  // Keep the highlighted result in view as the arrow keys move through the list.
  useEffect(() => {
    document.getElementById(`global-search-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (to) => {
    onClose();
    navigate(to);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && flat[active]) {
      e.preventDefault();
      go(flat[active].to);
    }
  };

  let index = -1;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-label="Search"
      sx={{ '& .MuiDialog-container': { alignItems: 'flex-start' } }}
      slotProps={{
        backdrop: { sx: { bgcolor: 'rgba(15, 23, 42, 0.35)', backdropFilter: 'blur(6px)' } },
        paper: {
          sx: { mt: { xs: 2, sm: '12vh' }, mx: 2, borderRadius: 3, display: 'flex', flexDirection: 'column', maxHeight: 'min(70vh, 640px)', overflow: 'hidden' },
        },
      }}
    >
      <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <TextField
          autoFocus
          fullWidth
          variant="standard"
          placeholder="Search..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          slotProps={{
            input: {
              disableUnderline: true,
              startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>,
              endAdornment: <InputAdornment position="end"><LdapQueryButton value={text.trim().startsWith('(') ? text.trim() : ''} onApply={setText} title="LDAP query builder for people" /></InputAdornment>,
              sx: { fontSize: '1.1rem' },
            },
            htmlInput: { 'aria-label': 'Search the console', 'aria-autocomplete': 'list' },
          }}
        />
      </Box>

      <Box sx={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {error && <Typography color="error" variant="body2" sx={{ px: 2, py: 1 }}>{error}</Typography>}
        {q.length < 2 && !error && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
            Search across users, groups, applications, integrations, and documentation. Type at least two characters. People search also takes an LDAP filter, such as (&amp;(department=Underwater Basket-Weaving)(mail=*)).
          </Typography>
        )}
        {sections.map((s) => (
          <Box key={s.key} sx={{ pb: 1 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2, pt: 1 }}>
              <Typography variant="overline" color="text.secondary">
                {s.title} · {s.block.total}
              </Typography>
              {s.block.total > 0 && <Button size="small" onClick={() => go(`${s.list}?${new URLSearchParams({ q })}`)}>See all</Button>}
            </Stack>
            {s.block.error && <Typography color="error" variant="body2" sx={{ px: 2 }}>{s.block.error}</Typography>}
            <List dense disablePadding>
              {s.block.results.map((r) => {
                index += 1;
                const i = index;
                const row = s.row(r, q, productName);
                return (
                  <ListItemButton
                    key={`${s.key}-${r.id ?? r.slug}`}
                    id={`global-search-${i}`}
                    selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(row.to)}
                    sx={{ mx: 1, borderRadius: 2 }}
                  >
                    <ListItemText primary={row.label} secondary={row.detail} slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }} />
                  </ListItemButton>
                );
              })}
            </List>
          </Box>
        ))}
        {data && flat.length === 0 && !error && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>No matches for “{q}”.</Typography>
        )}
      </Box>

      <Stack direction="row" spacing={2} sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary">↑ ↓ to move</Typography>
        <Typography variant="caption" color="text.secondary">Enter to open</Typography>
        <Typography variant="caption" color="text.secondary">Esc to close</Typography>
      </Stack>
    </Dialog>
  );
}
