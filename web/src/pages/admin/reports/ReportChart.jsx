import { Box, Typography } from '@mui/material';

// The chart of a builder report, drawn as SVG from the labels and values the server computed. The same numbers are listed under the
// chart, so a screen reader or a person who wants exact figures gets them too.
const COLORS = ['#1f5fbf', '#2e7d32', '#b26a00', '#8e24aa', '#00838f', '#c62828', '#5d4037', '#37474f'];
const W = 640;
const H = 320;
const PAD = { top: 16, right: 16, bottom: 88, left: 56 };

const shorten = (s, n = 18) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function Bars({ labels, values }) {
  const max = Math.max(1, ...values);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(labels.length, 1);
  const barW = Math.max(4, slot * 0.7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart" style={{ width: '100%', maxWidth: W, height: 'auto' }}>
      {[0, 0.5, 1].map((t) => {
        const y = PAD.top + innerH - innerH * t;
        return <g key={t}><line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.15" /><text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize="11" fill="currentColor">{Math.round(max * t)}</text></g>;
      })}
      {labels.map((label, i) => {
        const h = (values[i] / max) * innerH;
        const x = PAD.left + i * slot + (slot - barW) / 2;
        const y = PAD.top + innerH - h;
        return (
          <g key={`${label}-${i}`}>
            <rect x={x} y={y} width={barW} height={h} fill={COLORS[i % COLORS.length]} rx="2" />
            <text x={x + barW / 2} y={H - PAD.bottom + 16} textAnchor="end" fontSize="11" fill="currentColor" transform={`rotate(-35 ${x + barW / 2} ${H - PAD.bottom + 16})`}>{shorten(label)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Line({ labels, values }) {
  const max = Math.max(1, ...values);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = labels.length > 1 ? innerW / (labels.length - 1) : 0;
  const pts = values.map((v, i) => [PAD.left + i * step, PAD.top + innerH - (v / max) * innerH]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Line chart" style={{ width: '100%', maxWidth: W, height: 'auto' }}>
      {[0, 0.5, 1].map((t) => {
        const y = PAD.top + innerH - innerH * t;
        return <g key={t}><line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.15" /><text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize="11" fill="currentColor">{Math.round(max * t)}</text></g>;
      })}
      <polyline fill="none" stroke={COLORS[0]} strokeWidth="2.5" points={pts.map((p) => p.join(',')).join(' ')} />
      {pts.map(([x, y], i) => (
        <g key={`${labels[i]}-${i}`}>
          <circle cx={x} cy={y} r="3.5" fill={COLORS[0]} />
          {labels.length <= 16 || i % Math.ceil(labels.length / 16) === 0 ? (
            <text x={x} y={H - PAD.bottom + 16} textAnchor="end" fontSize="11" fill="currentColor" transform={`rotate(-35 ${x} ${H - PAD.bottom + 16})`}>{shorten(labels[i])}</text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

function Pie({ labels, values }) {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = 150; const cy = 150; const r = 130;
  let angle = -Math.PI / 2;
  const slices = values.map((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    const a0 = angle; const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const d = values.length === 1
      ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
      : `M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`;
    return { d, color: COLORS[i % COLORS.length], label: labels[i], value: v, share: Math.round((v / total) * 1000) / 10 };
  });
  return (
    <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
      <svg viewBox="0 0 300 300" role="img" aria-label="Pie chart" style={{ width: 260, height: 260 }}>
        {slices.map((s, i) => <path key={`${s.label}-${i}`} d={s.d} fill={s.color} stroke="white" strokeWidth="1" />)}
      </svg>
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {slices.map((s, i) => (
          <Box component="li" key={`${s.label}-${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <Box component="span" sx={{ width: 12, height: 12, borderRadius: '2px', bgcolor: s.color, display: 'inline-block' }} />
            <Typography variant="body2">{s.label}: {s.value} ({s.share}%)</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export default function ReportChart({ chart }) {
  if (!chart || !chart.labels.length) return <Typography color="text.secondary">Nothing to chart: no rows matched.</Typography>;
  const Chart = { bar: Bars, line: Line, pie: Pie }[chart.type] || Bars;
  return (
    <Box>
      <Typography variant="subtitle2" component="h3" gutterBottom>{chart.label}</Typography>
      <Chart labels={chart.labels} values={chart.values} />
    </Box>
  );
}
