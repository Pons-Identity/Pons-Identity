import { useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, TextField, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import ResultTable from './ResultTable.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const STATUS_COLOR = { ok: 'success', error: 'error', timeout: 'warning' };

// Runs a report with the person's own access and shows what came back. Nothing is saved.
export default function RunPanel({ path, name, initialInput = {}, disabled = false, note }) {
  const [input, setInput] = useState(() => JSON.stringify(initialInput, null, 2));
  const [out, setOut] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setError('');
    let parsed;
    try { parsed = input.trim() ? JSON.parse(input) : null; } catch { setError('The input is not valid JSON.'); return; }
    setRunning(true);
    try {
      setOut(await api(path, { method: 'POST', body: { input: parsed } }));
    } catch (err) { setError(errorText(err)); setOut(null); } finally { setRunning(false); }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6" component="h2">Run</Typography>
        <Typography variant="body2" color="text.secondary">{note || 'Runs with your own access, so you see only what you are allowed to see. A report only reads; it never changes anything. The result is shown here and not stored.'}</Typography>
        {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
        <TextField label="Input (JSON)" multiline minRows={2} value={input} onChange={(e) => setInput(e.target.value)}
          slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: 'monospace', fontSize: 13 } } }} helperText="Available to the script as input." />
        <Button variant="contained" onClick={run} disabled={running || disabled} sx={{ alignSelf: 'flex-start' }}>{running ? 'Running…' : 'Run report'}</Button>
        {out && (
          <Stack spacing={1} aria-label="Run output">
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip size="small" color={STATUS_COLOR[out.status]} label={out.status} />
              <Typography variant="body2">{out.duration_ms} ms</Typography>
            </Stack>
            {out.error && <Typography role="alert" color="error" variant="body2">{out.error.line ? `Line ${out.error.line}: ` : ''}{out.error.message}</Typography>}
            {out.logs.length > 0 && (
              <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                {out.logs.map((l) => `${l.level === 'log' ? '' : `[${l.level}] `}${l.text}`).join('\n')}
              </Box>
            )}
            {out.status === 'ok' && <ResultTable name={name} result={out.result} />}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
