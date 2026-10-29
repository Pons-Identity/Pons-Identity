import { useEffect, useState } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { api } from '../api/client.js';

// What each kind of thing is searched with, and how a result becomes an option. Applications and SAML service providers come
// from one list; the calculators tell them apart by `kind`.
const KINDS = {
  user: { path: '/admin/users', option: (u) => ({ key: String(u.id), id: u.id, label: u.username, secondary: u.display_name && u.display_name !== u.username ? u.display_name : '' }) },
  group: { path: '/admin/groups', option: (g) => ({ key: String(g.id), id: g.id, label: g.name, secondary: g.description || '' }) },
  app: {
    path: '/admin/applications',
    option: (a) => ({ key: `${a.protocol === 'saml' ? 'sp' : 'app'}:${a.id}`, id: a.id, kind: a.protocol === 'saml' ? 'sp' : 'app', label: a.name, secondary: { saml: 'SAML', cas: 'CAS', oidc: 'OpenID Connect', oauth2: 'OAuth 2.0' }[a.protocol] || a.protocol }),
  },
};
const MAX_SHOWN = 50;

/**
 * Picks one person, group or application by searching as the administrator types. `value` is an option (as this component
 * gives it to onChange) or null. Clearing the field clears the choice, which is how a calculator is asked about the other half.
 */
export default function CalculatorPicker({ type, label, value, onChange, helperText, disabled = false }) {
  const spec = KINDS[type];
  const [text, setText] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (disabled) return undefined;
    let stale = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api(`${spec.path}?q=${encodeURIComponent(text)}`);
        if (!stale) setOptions((Array.isArray(data) ? data : []).slice(0, MAX_SHOWN).map(spec.option));
      } catch {
        if (!stale) setOptions([]);
      } finally {
        if (!stale) setLoading(false);
      }
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [text, spec, disabled]);

  return (
    <Autocomplete
      size="small"
      disabled={disabled}
      sx={{ width: { xs: '100%', sm: 340 } }}
      options={value && !options.some((o) => o.key === value.key) ? [value, ...options] : options}
      value={value}
      loading={loading}
      filterOptions={(all) => all}
      isOptionEqual={(a, b) => a.key === b.key}
      getOptionLabel={(o) => o.label}
      getOptionKey={(o) => o.key}
      onChange={(_, next) => onChange(next)}
      onInputChange={(_, next, reason) => { if (reason !== 'reset') setText(next); }}
      noOptionsText="Nothing matches."
      renderOption={(props, o) => {
        const { key, ...rest } = props;
        return <li key={key} {...rest}>{o.label}{o.secondary ? <span style={{ marginLeft: 8, opacity: 0.7 }}>{o.secondary}</span> : null}</li>;
      }}
      renderInput={(params) => <TextField {...params} label={label} helperText={helperText} />}
    />
  );
}
