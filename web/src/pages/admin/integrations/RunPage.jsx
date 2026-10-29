import { useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { LEVEL_LABEL, lightLineColor } from '../../../components/LogLines.jsx';

const BASE = '/admin/integrations';
const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const pad = (n, width = 2) => String(n).padStart(width, '0');
const BLANK = { text: ' ' };

// A time as the console's log shows it: 2026/10/25 17:45:53.769.
function stamp(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// A length of time as 00:00:00.782.
function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}.${pad(ms % 1000, 3)}`;
}

// Whether this load of the page is a reload, which runs the integration again.
const isReload = () => globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type === 'reload';

// The run as lines of plain text, each { text, color }: the node and the script, what it logged and printed in the order it
// happened, then how it ended and when.
function linesOf({ integration, run }) {
  const printed = [
    ...run.logs.map((l) => ({ time: l.time, color: l.color, text: `${l.time ? `${stamp(l.time)}: ` : ''}${LEVEL_LABEL[l.level] || l.level} ${l.text}` })),
    ...run.output.map((o) => ({ time: o.time, color: o.color, text: o.text })),
  ].sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
  const lines = [{ text: `Node: ${run.node || 'unknown'}` }, { text: `Running ${integration.name}` }, BLANK, ...printed, BLANK];
  if (run.status === 'running') return lines;
  const failure = run.error ? `${run.error.line ? `Line ${run.error.line}: ` : ''}${run.error.message}` : '';
  lines.push(run.status === 'ok' ? { text: 'Completed.' } : { text: `${run.status === 'timeout' ? 'Timed out' : 'Failed'}.${failure ? ` ${failure}` : ''}` });
  if (run.result !== null && run.result !== undefined) lines.push({ text: `Result:\n${JSON.stringify(run.result, null, 2)}` });
  lines.push(BLANK, { text: `Start time: ${stamp(run.started_at)}` });
  if (run.finished_at) lines.push({ text: `End time: ${stamp(run.finished_at)}` });
  lines.push({ text: `Run time: ${elapsed(run.duration_ms)}` });
  return lines;
}

// One run, as plain text on a white page. While it runs, each line is sent as the script prints it, over a stream the server keeps
// open until the run ends. A reload of the page runs the integration again with the input of the run shown, and the page moves to
// that new run; opening a run without reloading only shows it.
export default function RunPage() {
  const { id, runId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const reran = useRef(false);

  useEffect(() => {
    let live = true;
    let stream = null;
    const update = (change) => setData((cur) => cur && { ...cur, run: change(cur.run) });
    const showRun = () => api(`${BASE}/${id}/runs/${runId}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        if (d.run.status !== 'running') return;
        stream = new EventSource(`/api${BASE}/${id}/runs/${runId}/stream`);
        // A snapshot replaces the lines, so a reconnect does not repeat them.
        stream.addEventListener('snapshot', (e) => { const { logs, output } = JSON.parse(e.data); update((r) => ({ ...r, logs, output })); });
        stream.addEventListener('line', (e) => { const { stream: kind, line } = JSON.parse(e.data); update((r) => ({ ...r, [kind]: [...r[kind], line] })); });
        stream.addEventListener('end', (e) => { stream.close(); update(() => JSON.parse(e.data)); });
      })
      .catch((e) => { if (live) setError(errorText(e)); });

    // Only the first load after a reload starts a run: the page then moves to the new run, which this page does not start again.
    if (isReload() && !reran.current) {
      reran.current = true;
      api(`${BASE}/${id}/runs/${runId}/rerun`, { method: 'POST' })
        .then(({ run }) => navigate(`${BASE}/${id}/runs/${run.id}`, { replace: true }))
        .catch((e) => { setError(errorText(e)); showRun(); });
    } else {
      showRun();
    }
    return () => { live = false; stream?.close(); };
  }, [id, runId, navigate]);

  return (
    <Box aria-label="Run page" sx={{ bgcolor: '#fff', color: '#000', minHeight: '100vh', p: 2 }}>
      {error && <Box component="p" role="alert" sx={{ m: 0, mb: 2, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{error}</Box>}
      {data && (
        <>
          <Box component="h1" sx={{ m: 0, mb: 2, fontFamily: 'serif', fontSize: '2em', fontWeight: 'bold' }}>{`${data.integration.name} (run #${data.run.id})`}</Box>
          <Box component="pre" sx={{ m: 0, fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {linesOf(data).map((l, i) => <Box key={i} component="span" sx={{ display: 'block', color: lightLineColor(l.color) }}>{l.text}</Box>)}
          </Box>
        </>
      )}
    </Box>
  );
}
