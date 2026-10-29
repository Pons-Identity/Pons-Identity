import { Autocomplete, Box, Button, IconButton, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';

// Same limit as the server (integrations/inputs.js).
export const MAX_INPUTS = 20;

// The inputs a script or function takes, one row each: the name the caller passes (chosen from `catalog`, alphabetical, or typed),
// and the variable the code reads it from. Rows can be added and removed.
export default function InputsTable({ value, onChange, catalog = [], disabled = false, helperText }) {
  const set = (i, patch) => onChange(value.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const remove = (i) => onChange(value.filter((_, j) => j !== i));
  const add = () => onChange([...value, { name: '', variable: '' }]);
  const names = catalog.map((c) => c.name);
  const described = new Map(catalog.map((c) => [c.name, c.description]));

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle1" component="h3">Inputs</Typography>
      {helperText && <Typography variant="body2" color="text.secondary">{helperText}</Typography>}
      <Table size="small" aria-label="Inputs">
        <TableHead>
          <TableRow>
            <TableCell>Input</TableCell>
            <TableCell>Variable in code</TableCell>
            {!disabled && <TableCell />}
          </TableRow>
        </TableHead>
        <TableBody>
          {value.length === 0 && (
            <TableRow><TableCell colSpan={disabled ? 2 : 3}><Typography color="text.secondary">No inputs.</Typography></TableCell></TableRow>
          )}
          {value.map((row, i) => (
            <TableRow key={i}>
              <TableCell>
                <Autocomplete freeSolo size="small" fullWidth options={names} value={row.name} disabled={disabled}
                  onInputChange={(_, text) => set(i, { name: text })} onChange={(_, text) => set(i, { name: text || '' })}
                  renderOption={(props, option) => (
                    <Box component="li" {...props} key={option} sx={{ display: 'flex', gap: 1.5, alignItems: 'baseline' }}>
                      <code>{option}</code>
                      <Typography variant="caption" color="text.secondary">{described.get(option)}</Typography>
                    </Box>
                  )}
                  renderInput={(params) => (
                    <TextField {...params} placeholder="Choose or type a name"
                      slotProps={{ htmlInput: { ...params.inputProps, 'aria-label': `Input ${i + 1} name` } }} />
                  )} />
              </TableCell>
              <TableCell>
                <TextField size="small" fullWidth value={row.variable} disabled={disabled}
                  onChange={(e) => set(i, { variable: e.target.value })}
                  slotProps={{ htmlInput: { 'aria-label': `Input ${i + 1} variable`, style: { fontFamily: 'monospace', fontSize: 13 } } }} />
              </TableCell>
              {!disabled && (
                <TableCell align="right">
                  <IconButton size="small" aria-label={`Remove input ${i + 1}`} onClick={() => remove(i)}><DeleteIcon fontSize="small" /></IconButton>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!disabled && (
        <Button variant="outlined" onClick={add} disabled={value.length >= MAX_INPUTS} sx={{ alignSelf: 'flex-start' }}>Add input</Button>
      )}
    </Stack>
  );
}
