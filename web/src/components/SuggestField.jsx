import { useEffect, useState } from 'react';
import { Autocomplete, Typography, TextField } from '@mui/material';
import { api } from '../api/client.js';

/**
 * A filter box that behaves like a Select2: type to narrow a list fetched from the server as you type, and only a value that
 * really occurs can be chosen (nothing free-typed is kept). `source` is the endpoint that answers `?field=&q=` with
 * [{ value, label?, count }]. `value` is the chosen value or ''; onChange gets the value or ''.
 */
export default function SuggestField({ label, source, field, value, onChange, sx, placeholder = 'Any' }) {
  const [options, setOptions] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    const t = setTimeout(() => {
      api(`${source}?${new URLSearchParams({ field, q: input })}`)
        .then((r) => { if (!stale) setOptions(Array.isArray(r) ? r : []); })
        .catch(() => { if (!stale) setOptions([]); })
        .finally(() => { if (!stale) setLoading(false); });
    }, input ? 200 : 0);
    return () => { stale = true; clearTimeout(t); };
  }, [source, field, input]);

  const chosen = value ? (options.find((o) => o.value === value) || { value, label: '', count: 0 }) : null;
  return (
    <Autocomplete
      size="small"
      sx={{ minWidth: 190, ...sx }}
      options={options}
      value={chosen}
      loading={loading}
      // The server already filtered by what was typed.
      filterOptions={(o) => o}
      isOptionEqualToValue={(a, b) => a.value === b.value}
      getOptionLabel={(o) => (o.label ? `${o.value} (${o.label})` : o.value)}
      onChange={(_, o) => onChange(o ? o.value : '')}
      onInputChange={(_, v, reason) => { if (reason === 'input') setInput(v); else if (reason === 'clear' || reason === 'reset') setInput(''); }}
      noOptionsText="Nothing matches"
      renderOption={({ key, ...props }, o) => (
        <li key={key} {...props}>
          <span>{o.value}{o.label && <Typography component="span" variant="body2" color="text.secondary"> — {o.label}</Typography>}</span>
          {o.count > 0 && <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 'auto', pl: 2 }}>{o.count.toLocaleString()}</Typography>}
        </li>
      )}
      renderInput={(params) => <TextField {...params} label={label} placeholder={placeholder} />}
    />
  );
}
