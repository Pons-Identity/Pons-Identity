import { Box, Button, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';

const SHOWN = 500;
const mono = { fontFamily: 'monospace', fontSize: 13 };

const isRow = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Rows when the result is a non-empty array of objects; otherwise null and the result is shown as JSON. */
export const rowsOf = (result) => (Array.isArray(result) && result.length > 0 && result.every(isRow) ? result : null);

export const columnsOf = (rows) => [...new Set(rows.flatMap((r) => Object.keys(r)))];

export const cellText = (v) => {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

// A spreadsheet runs a cell that starts with one of these as a formula, so such cells are made text.
const csvCell = (v) => {
  let t = cellText(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function toCsv(rows) {
  const cols = columnsOf(rows);
  return `${[cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n')}\r\n`;
}

function download(name, rows) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase() || 'report'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// What a report returned: a table with a CSV download when it is rows, JSON otherwise.
export default function ResultTable({ name, result }) {
  const rows = rowsOf(result);
  if (!rows) {
    return (
      <Box component="pre" aria-label="Report result" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...mono }}>
        {result === null || result === undefined ? 'The report returned nothing.' : Array.isArray(result) && result.length === 0 ? 'No rows.' : JSON.stringify(result, null, 2)}
      </Box>
    );
  }
  const cols = columnsOf(rows);
  return (
    <Stack spacing={1}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography variant="body2">{rows.length} row{rows.length === 1 ? '' : 's'}{rows.length > SHOWN && `, first ${SHOWN} shown (the download has all of them)`}</Typography>
        <Button size="small" startIcon={<DownloadIcon />} onClick={() => download(name, rows)}>Download CSV</Button>
      </Stack>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 520 }}>
        <Table size="small" stickyHeader aria-label="Report result">
          <TableHead><TableRow>{cols.map((c) => <TableCell key={c}>{c}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {rows.slice(0, SHOWN).map((r, i) => (
              <TableRow key={i} hover>{cols.map((c) => <TableCell key={c} sx={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{cellText(r[c])}</TableCell>)}</TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
