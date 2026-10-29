import { useRef } from 'react';
import { Autocomplete, Checkbox, Chip, TextField, Typography, createFilterOptions } from '@mui/material';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';

const filter = createFilterOptions({ stringify: (o) => `${o.label} ${o.secondary || ''}` });
const MAX_SHOWN = 100;

/**
 * Pick any number of items from a long list: a combobox whose list can be searched by typing, with a checkbox beside each
 * option and the choices shown as chips. `options` are { id, label, secondary? }; `value` is the array of chosen ids.
 * `groupBy` puts options under headings (options must be in order), and `serverFiltered` skips the local matching when the
 * options already match what was typed. Pass `inputValue` with `onInputChange` to keep the typed text in the parent.
 */
export default function MultiCombobox({ label, options, value, onChange, disabled = false, placeholder = 'Search…', helperText, noOptionsText = 'Nothing matches.', groupBy, inputValue, onInputChange, serverFiltered = false }) {
  // Autocomplete clears the typed text whenever its value changes identity, and options change as the search does. So the
  // chosen list keeps its identity while the same choices are chosen.
  const chosenRef = useRef([]);
  const next = options.filter((o) => value.includes(o.id));
  const same = next.length === chosenRef.current.length && next.every((o, i) => o.id === chosenRef.current[i].id);
  if (!same) chosenRef.current = next;
  const chosen = chosenRef.current;
  return (
    <Autocomplete
      multiple
      disableCloseOnSelect
      disabled={disabled}
      options={options}
      value={chosen}
      onChange={(_, next) => onChange(next.map((o) => o.id))}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      getOptionLabel={(o) => o.label}
      groupBy={groupBy}
      inputValue={inputValue}
      onInputChange={(_, text, reason) => onInputChange?.(text, reason)}
      // A long list shows its first matches only, so typing is how the rest is reached.
      filterOptions={(all, state) => {
        if (serverFiltered) return all;
        const matches = filter(all, state);
        return matches.length > MAX_SHOWN ? matches.slice(0, MAX_SHOWN) : matches;
      }}
      noOptionsText={noOptionsText}
      renderOption={({ key, ...props }, option, { selected }) => (
        <li key={key} {...props}>
          <Checkbox icon={<CheckBoxOutlineBlankIcon fontSize="small" />} checkedIcon={<CheckBoxIcon fontSize="small" />} checked={selected} sx={{ mr: 1 }} tabIndex={-1} disableRipple />
          <span>{option.label}{option.secondary && <Typography component="span" variant="body2" color="text.secondary"> — {option.secondary}</Typography>}</span>
        </li>
      )}
      renderTags={(tags, getTagProps) => tags.map((o, i) => {
        const { key, ...tagProps } = getTagProps({ index: i });
        return <Chip key={key} size="small" label={o.label} {...tagProps} />;
      })}
      renderInput={(params) => <TextField {...params} label={label} placeholder={chosen.length ? '' : placeholder} helperText={helperText} />}
    />
  );
}
