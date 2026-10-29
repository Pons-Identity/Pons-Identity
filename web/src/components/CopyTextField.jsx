import { IconButton, InputAdornment, TextField } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useCopy } from './CopyButton.jsx';

// An editable text field with a copy button at its end. The button copies what is in the field now,
// so a value that was just typed is copied as it stands.
export default function CopyTextField({ label, value, copyLabel = label || 'value', slotProps, ...props }) {
  const copy = useCopy();
  const text = value == null ? '' : String(value);
  return (
    <TextField
      label={label}
      value={value}
      {...props}
      slotProps={{
        ...slotProps,
        input: {
          ...slotProps?.input,
          endAdornment: (
            <InputAdornment position="end">
              <IconButton edge="end" size="small" title="Copy" aria-label={`Copy ${copyLabel}`} disabled={!text} onClick={() => copy(text)}>
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
