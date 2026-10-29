import { Button } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useNotify } from './Notify.jsx';

export function useCopy() {
  const notify = useNotify();
  return async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      notify('Copied to clipboard');
    } catch {
      notify('Copy failed. Select the text and copy it manually.');
    }
  };
}

export default function CopyButton({ value, label = 'Copy' }) {
  const copy = useCopy();
  return (
    <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => copy(value)}>
      {label}
    </Button>
  );
}
