import { Button, IconButton, MenuItem, Stack, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import CopyTextField from './CopyTextField.jsx';

// Editable list of rows (replaces the cloned <template> rows in the old admin forms).
// fields: [{ key, label, options? }]. A field with options renders as a select.
// copyable: give each text field a copy button (selects never get one).
export default function RepeaterRows({ rows, onChange, fields, emptyRow, addLabel, copyable = false }) {
  const update = (i, key, value) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));

  return (
    <Stack spacing={1.5}>
      {rows.map((row, i) => (
        <Stack key={i} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          {fields.map((f) => {
            const Input = copyable && !f.options ? CopyTextField : TextField;
            return (
              <Input
                key={f.key}
                size="small"
                fullWidth
                select={Boolean(f.options)}
                label={f.label}
                value={row[f.key] ?? ''}
                onChange={(e) => update(i, f.key, e.target.value)}
              >
                {(f.options || []).map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </Input>
            );
          })}
          <IconButton aria-label="Remove row" onClick={() => remove(i)}>
            <DeleteIcon />
          </IconButton>
        </Stack>
      ))}
      <Button startIcon={<AddIcon />} onClick={() => onChange([...rows, { ...emptyRow }])} sx={{ alignSelf: 'flex-start' }}>
        {addLabel}
      </Button>
    </Stack>
  );
}
