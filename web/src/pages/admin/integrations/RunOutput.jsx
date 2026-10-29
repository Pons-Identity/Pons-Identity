import { useState } from 'react';
import { Box, Chip, Stack, Tab, Tabs, Typography } from '@mui/material';
import { STATUS_COLOR, when } from './IntegrationList.jsx';
import LogLines from '../../../components/LogLines.jsx';

const pre = { m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

// One run: how it ended, then a tab each for what the script printed (output), what it logged, and what it returned.
export default function RunOutput({ run, label = 'Run output' }) {
  const output = run.output || [];
  const hasResult = run.result !== null && run.result !== undefined;
  const [tab, setTab] = useState(() => (output.length ? 'output' : run.logs.length ? 'log' : hasResult ? 'result' : 'output'));
  return (
    <Stack spacing={1} aria-label={label}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Chip size="small" color={STATUS_COLOR[run.status]} label={run.status} />
        <Typography variant="body2">{when(run.started_at)} · {run.duration_ms} ms · {run.trigger}{run.actor && ` · ${run.actor}`}</Typography>
      </Stack>
      {run.error && <Typography role="alert" color="error" variant="body2">{run.error.line ? `Line ${run.error.line}: ` : ''}{run.error.message}</Typography>}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} aria-label={`${label} sections`}>
          <Tab value="output" label={`Output${output.length ? ` (${output.length})` : ''}`} />
          <Tab value="log" label={`Log${run.logs.length ? ` (${run.logs.length})` : ''}`} />
          <Tab value="result" label="Result" />
        </Tabs>
      </Box>
      {tab === 'output' && <LogLines lines={output} label="Output" empty="This run printed nothing. Use output() in the script to print here." />}
      {tab === 'log' && <LogLines lines={run.logs} label="Log" showLevel showTime empty="This run logged nothing. Use log(), log.debug(), log.warning() or log.error() in the script." />}
      {tab === 'result' && (hasResult
        ? <Box component="pre" sx={pre} aria-label="Result">{JSON.stringify(run.result, null, 2)}</Box>
        : <Typography variant="body2" color="text.secondary">The script returned nothing.</Typography>)}
    </Stack>
  );
}
