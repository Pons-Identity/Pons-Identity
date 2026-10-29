import { Autocomplete, Button, IconButton, MenuItem, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';

// Same limit as the server (integrations/inputs.js).
export const MAX_VALUES = 20;

export const VALUE_TYPES = [
  { id: 'text', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'yes_no', label: 'Yes or no' },
  { id: 'json', label: 'JSON' },
];
const PLACEHOLDER = { text: '', number: 'e.g. 90', yes_no: 'yes or no', json: 'e.g. {"x": 1}' };

// The values an input is given, one row each: the input's name, and the value typed in its box (as the type says). A blank value is
// not set. `names` are offered for the name, but any name can be typed, which makes a custom input. A name in `locked` is shown as
// it is and cannot be changed or removed. With `fields` (an event trigger), a row can take a field of the event instead of a typed value.
export default function ValueTable({ value, onChange, names = [], locked = [], fields = null, disabled = false, addLabel = 'Add an input', helperText }) {
  const set = (i, patch) => onChange(value.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const remove = (i) => onChange(value.filter((_, j) => j !== i));
  const add = () => onChange([...value, { name: '', type: 'text', value: '', from: '' }]);
  const columns = (fields ? 4 : 3) + (disabled ? 0 : 1);

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle1" component="h3">Input values</Typography>
      {helperText && <Typography variant="body2" color="text.secondary">{helperText}</Typography>}
      <Table size="small" aria-label="Input values">
        <TableHead>
          <TableRow>
            <TableCell>Input</TableCell>
            {fields && <TableCell>From</TableCell>}
            <TableCell>Type</TableCell>
            <TableCell>Value</TableCell>
            {!disabled && <TableCell />}
          </TableRow>
        </TableHead>
        <TableBody>
          {value.length === 0 && (
            <TableRow><TableCell colSpan={columns}><Typography color="text.secondary">No inputs.</Typography></TableCell></TableRow>
          )}
          {value.map((row, i) => {
            const isLocked = locked.includes(row.name);
            const fromField = Boolean(row.from);
            return (
              <TableRow key={i}>
                <TableCell sx={{ minWidth: 180 }}>
                  {isLocked ? <code>{row.name}</code> : (
                    <Autocomplete freeSolo size="small" options={names} value={row.name} disabled={disabled}
                      onInputChange={(_, text) => set(i, { name: text })} onChange={(_, text) => set(i, { name: text || '' })}
                      renderInput={(params) => (
                        <TextField {...params} placeholder="Choose or type a name"
                          slotProps={{ htmlInput: { ...params.inputProps, 'aria-label': `Input ${i + 1} name` } }} />
                      )} />
                  )}
                </TableCell>
                {fields && (
                  <TableCell sx={{ minWidth: 200 }}>
                    <TextField select size="small" fullWidth value={row.from} disabled={disabled} slotProps={{ htmlInput: { 'aria-label': `Input ${i + 1} from` } }}
                      onChange={(e) => set(i, { from: e.target.value })}>
                      <MenuItem value="">Typed value</MenuItem>
                      {fields.map((f) => <MenuItem key={f} value={f}><code>{f}</code></MenuItem>)}
                    </TextField>
                  </TableCell>
                )}
                <TableCell sx={{ minWidth: 140 }}>
                  <TextField select size="small" fullWidth value={row.type} disabled={disabled || fromField}
                    slotProps={{ htmlInput: { 'aria-label': `Input ${i + 1} type` } }} onChange={(e) => set(i, { type: e.target.value })}>
                    {VALUE_TYPES.map((t) => <MenuItem key={t.id} value={t.id}>{t.label}</MenuItem>)}
                  </TextField>
                </TableCell>
                <TableCell sx={{ minWidth: 220 }}>
                  {fromField ? <Typography variant="body2" color="text.secondary">Taken from the event</Typography> : (
                    <TextField size="small" fullWidth value={row.value} disabled={disabled} placeholder={PLACEHOLDER[row.type]}
                      onChange={(e) => set(i, { value: e.target.value })}
                      slotProps={{ htmlInput: { 'aria-label': `Input ${i + 1} value`, style: { fontFamily: row.type === 'json' ? 'monospace' : undefined, fontSize: 13 } } }} />
                  )}
                </TableCell>
                {!disabled && (
                  <TableCell align="right">
                    {!isLocked && <IconButton size="small" aria-label={`Remove input ${i + 1}`} onClick={() => remove(i)}><DeleteIcon fontSize="small" /></IconButton>}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {!disabled && (
        <Button variant="outlined" onClick={add} disabled={value.length >= MAX_VALUES} sx={{ alignSelf: 'flex-start' }}>{addLabel}</Button>
      )}
    </Stack>
  );
}

// Keeps only what the server takes for a row: its name, type and value (and `from` when it is set).
export const valueBody = (rows) => rows.map(({ name, type, value, from }) => (from ? { name, type, value: '', from } : { name, type, value }));
