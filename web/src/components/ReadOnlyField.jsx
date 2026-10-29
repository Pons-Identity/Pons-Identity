import { IconButton, InputAdornment, TextField, Tooltip } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useCopy } from './CopyButton.jsx';

// A read-only value with a copy button inside the field.
export default function ReadOnlyField({ label, value, multiline = false }) {
  const copy = useCopy();
  const text = value == null ? '' : String(value);
  return (
    <TextField
      label={label}
      value={text}
      multiline={multiline}
      size="small"
      fullWidth
      slotProps={{
        input: {
          readOnly: true,
          sx: { fontFamily: 'monospace', fontSize: 14 },
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title="Copy">
                <IconButton edge="end" size="small" aria-label={`Copy ${label}`} onClick={() => copy(text)}>
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
