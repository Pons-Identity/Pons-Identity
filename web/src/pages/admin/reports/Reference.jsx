import { Box, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';

const mono = { fontFamily: 'monospace', fontSize: 13 };
const pre = { m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...mono };
import CopyButton from '../../../components/CopyButton.jsx';
import DownloadTextButton from '../../../components/DownloadTextButton.jsx';

// The same content as Reference, as plain text with no markup, for pasting into an LLM that helps write a script.
export function referenceText(reference) {
  const out = [
    'REPORT SCRIPT REFERENCE',
    '',
    'Reports are read-only. Besides report.* they can use input, log(), csv.parse and util.*, and they cannot see integration variables or call outside services.',
    'Each function needs the permission shown, held by the person who runs the report.',
    '',
    'FUNCTIONS',
  ];
  reference.functions.forEach((f) => {
    out.push('', f.signature, `  ${f.description}`, `  Needs ${f.requires}. Returns ${f.returns}.`, '  Example:', ...f.example.split('\n').map((line) => `    ${line}`));
  });
  out.push('', 'ROWS FROM report.users');
  reference.userFields.forEach((f) => out.push(`  ${f.name}: ${f.type}${f.description ? `. ${f.description}` : ''}`));
  return `${out.join('\n')}\n`;
}

// What a report script can call and the shape of a user row. It comes from the server, so it is what this server really has.
export default function Reference({ reference }) {
  return (
    <Stack spacing={3}>
      <Box>
        <CopyButton value={referenceText(reference)} label="Copy as text" />
        <DownloadTextButton value={referenceText(reference)} filename="report-script-reference.txt" />
      </Box>
      <Typography variant="body2" color="text.secondary">
        Reports are read-only. Besides <code>report.*</code> they can use <code>input</code>, <code>log()</code>, <code>csv.parse</code> and <code>util.*</code>, and
        they cannot see integration variables or call outside services. Each function needs the permission shown, held by the person who runs the report.
      </Typography>
      {reference.functions.map((f) => (
        <Box key={f.signature} component="section">
          <Typography variant="subtitle1" component="h3" sx={{ ...mono, fontWeight: 600 }}>{f.signature}</Typography>
          <Typography variant="body2">{f.description}</Typography>
          <Typography variant="body2" color="text.secondary">Needs <code>{f.requires}</code>. Returns <code>{f.returns}</code>.</Typography>
          <Box component="pre" sx={{ ...pre, mt: 1 }}>{f.example}</Box>
        </Box>
      ))}
      <Box component="section">
        <Typography variant="subtitle1" component="h3" gutterBottom>Rows from report.users</Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label="User row fields">
            <TableHead><TableRow><TableCell>Field</TableCell><TableCell>Type</TableCell><TableCell>Notes</TableCell></TableRow></TableHead>
            <TableBody>
              {reference.userFields.map((f) => (
                <TableRow key={f.name}><TableCell sx={mono}>{f.name}</TableCell><TableCell sx={mono}>{f.type}</TableCell><TableCell>{f.description}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </Stack>
  );
}
