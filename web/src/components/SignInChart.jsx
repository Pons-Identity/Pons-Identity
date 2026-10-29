import { useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography, useTheme } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

// Two smoothed lines over the last 24 hours, one point per 15 minutes, each passing through its values. Colors are the validated categorical slots 1 and 2 (blue, orange),
// stepped for the dark surface; the legend and the table carry identity, so color is never the only cue.
const COLORS = {
  light: { succeeded: '#2a78d6', failed: '#eb6834' },
  dark: { succeeded: '#3987e5', failed: '#d95926' },
};

const W = 640;
const H = 220;
const PAD = { l: 40, r: 12, t: 12, b: 28 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;

// A y-axis top that is a round number and divisible by four, so the four gridlines land on whole counts.
function axisTop(max) {
  if (max <= 0) return 4;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  const nice = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
  return 4 * Math.ceil(nice / 4);
}

// A smooth curve through every point (monotone cubic, Fritsch–Carlson). It never overshoots between points, so a run of zero hours stays at zero.
function smoothPath(pts) {
  const n = pts.length;
  const dx = [];
  const d = [];
  for (let k = 0; k < n - 1; k++) {
    dx.push(pts[k + 1][0] - pts[k][0]);
    d.push((pts[k + 1][1] - pts[k][1]) / dx[k]);
  }
  const m = pts.map((_, k) => {
    if (k === 0) return d[0];
    if (k === n - 1) return d[n - 2];
    return d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  });
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const a = m[k] / d[k];
    const b = m[k + 1] / d[k];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[k] = t * a * d[k];
      m[k + 1] = t * b * d[k];
    }
  }
  let path = `M${pts[0][0]},${pts[0][1]}`;
  for (let k = 0; k < n - 1; k++) {
    const h = dx[k] / 3;
    path += ` C${pts[k][0] + h},${pts[k][1] + m[k] * h} ${pts[k + 1][0] - h},${pts[k + 1][1] - m[k + 1] * h} ${pts[k + 1][0]},${pts[k + 1][1]}`;
  }
  return path;
}

const BUCKET_SECONDS = 15 * 60;
const timeLabel = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const LABELED = [0, 24, 48, 72, 95]; // every six hours, plus the last bucket

export default function SignInChart({ buckets }) {
  const theme = useTheme();
  const colors = COLORS[theme.palette.mode] || COLORS.light;
  const surface = theme.palette.background.paper;
  const muted = theme.palette.text.secondary;
  const grid = theme.palette.divider;
  const [hover, setHover] = useState(null);

  const n = buckets.length;
  const top = axisTop(Math.max(0, ...buckets.flatMap((b) => [b.succeeded, b.failed])));
  const x = (i) => PAD.l + (i * PLOT_W) / (n - 1);
  const y = (v) => PAD.t + PLOT_H * (1 - v / top);
  const ticks = [0, 1, 2, 3, 4].map((k) => (top * k) / 4);
  const series = [['succeeded', 'Successful sign-ins'], ['failed', 'Failed or denied']];

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    setHover(Math.min(n - 1, Math.max(0, Math.round(((sx - PAD.l) / PLOT_W) * (n - 1)))));
  };
  const h = hover === null ? null : buckets[hover];

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={3} useFlexGap flexWrap="wrap" aria-label="Legend">
        {series.map(([key, label]) => (
          <Stack key={key} direction="row" spacing={1} alignItems="center">
            <Box sx={{ width: 16, height: 3, borderRadius: 2, bgcolor: colors[key] }} />
            <Typography variant="body2">{label}</Typography>
          </Stack>
        ))}
      </Stack>

      <Box sx={{ position: 'relative' }}>
        <Box component="svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sign-ins per 15 minutes over the last 24 hours"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}
          sx={{ width: '100%', height: 'auto', display: 'block', touchAction: 'pan-y' }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={grid} strokeWidth={1} />
              <text x={PAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={muted}>{t.toLocaleString()}</text>
            </g>
          ))}
          {buckets.map((b, i) => LABELED.includes(i) && (
            <text key={b.ts} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={11} fill={muted}>
              {timeLabel(b.ts)}
            </text>
          ))}
          {series.map(([key]) => (
            <g key={key}>
              <path fill="none" stroke={colors[key]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
                d={smoothPath(buckets.map((b, i) => [x(i), y(b[key])]))} />
              {hover !== null && (
                <circle cx={x(hover)} cy={y(buckets[hover][key])} r={4.5} fill={colors[key]} stroke={surface} strokeWidth={2} />
              )}
            </g>
          ))}
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + PLOT_H} stroke={muted} strokeWidth={1} />
          )}
        </Box>

        {h && (
          <Paper variant="outlined" sx={{
            position: 'absolute', top: 0, pointerEvents: 'none', px: 1.5, py: 1, minWidth: 170,
            left: `${(x(hover) / W) * 100}%`,
            transform: hover > n / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
          }}>
            <Typography variant="caption" color="text.secondary">{timeLabel(h.ts)} – {timeLabel(h.ts + BUCKET_SECONDS)}</Typography>
            {series.map(([key, label]) => (
              <Stack key={key} direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Stack direction="row" spacing={1} alignItems="center">
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: colors[key] }} />
                  <Typography variant="body2">{label}</Typography>
                </Stack>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{h[key].toLocaleString()}</Typography>
              </Stack>
            ))}
          </Paper>
        )}
      </Box>

      <Accordion disableGutters variant="outlined" elevation={0}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="body2">Show as table</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <TableContainer>
            <Table size="small" aria-label="Sign-ins per 15 minutes">
              <TableHead>
                <TableRow>
                  <TableCell>Time starting</TableCell>
                  <TableCell align="right">Successful</TableCell>
                  <TableCell align="right">Failed or denied</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {buckets.map((b) => (
                  <TableRow key={b.ts}>
                    <TableCell>{timeLabel(b.ts)}</TableCell>
                    <TableCell align="right">{b.succeeded.toLocaleString()}</TableCell>
                    <TableCell align="right">{b.failed.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}
