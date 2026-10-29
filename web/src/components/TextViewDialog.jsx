import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import CopyButton from './CopyButton.jsx';

// Shows a certificate or metadata document in a read-only box.
export default function TextViewDialog({ open, title, text, onClose }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <TextField multiline fullWidth minRows={10} maxRows={24} value={text} sx={{ mt: 1 }}
          slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12 } }, htmlInput: { 'aria-label': title } }} />
      </DialogContent>
      <DialogActions>
        <CopyButton value={text} />
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
