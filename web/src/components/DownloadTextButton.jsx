import { Button } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';

// Saves the text as a .txt file. The link is created, clicked and removed here, and its URL is revoked afterwards.
export function downloadText(filename, value) {
  const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function DownloadTextButton({ value, filename, label = 'Download as text' }) {
  return (
    <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadText(filename, value)}>
      {label}
    </Button>
  );
}
