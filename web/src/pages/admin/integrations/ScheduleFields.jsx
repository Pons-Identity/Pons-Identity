import { Box, Button, Checkbox, FormControlLabel, FormGroup, MenuItem, Stack, TextField, Typography } from '@mui/material';
import ValueTable, { valueBody } from './ValueTable.jsx';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UNIT_NAMES = { minute: 'Minutes', hour: 'Hours', day: 'Days', week: 'Weeks' };
const today = () => new Date().toISOString().slice(0, 10);

// A schedule as the form edits it. `key` tells the rows apart on screen; `id` is the saved schedule's, if it has one.
let keySeq = 0;
export const newSchedule = (saved) => ({
  type: 'daily', minutes: 60, at: '02:00', day: 1, unit: 'week', days: [1], every: 1, starts_on: today(), ends_on: '',
  ...saved, key: ++keySeq,
});

// The form's timing fields as what the server takes.
const timing = (f) => (f.type === 'interval' ? { type: 'interval', minutes: Number(f.minutes) }
  : f.type === 'daily' || f.type === 'weekdays' ? { type: f.type, at: f.at }
    : f.type === 'weekly' ? { type: 'weekly', day: Number(f.day), at: f.at }
      : f.type === 'monthly' ? { type: 'monthly', day: Number(f.day), at: f.at }
        : { type: 'custom', unit: f.unit, every: Number(f.every), days: f.unit === 'week' ? f.days : [], at: f.at, starts_on: f.starts_on, ends_on: f.ends_on });

// The schedule as what the server takes. Its input values are sent only when there are some.
export const scheduleBody = (f) => ({ ...timing(f), ...(f.inputs?.length ? { inputs: valueBody(f.inputs) } : {}) });

// One schedule in the Triggers section: its type and the fields that type needs.
export default function ScheduleFields({ value, limits, names, disabled, note, onChange, onRemove }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'flex-start' }}>
          <TextField select label="Schedule" value={value.type} disabled={disabled} sx={{ minWidth: 200 }} onChange={(e) => set('type', e.target.value)}>
            <MenuItem value="interval">Every so often</MenuItem>
            <MenuItem value="daily">Every day</MenuItem>
            <MenuItem value="weekdays">Every weekday (Mon–Fri)</MenuItem>
            <MenuItem value="weekly">Every week</MenuItem>
            <MenuItem value="monthly">Every month</MenuItem>
            <MenuItem value="custom">Custom…</MenuItem>
          </TextField>
          {value.type === 'interval' && (
            <TextField label="Minutes between runs" type="number" value={value.minutes} disabled={disabled} onChange={(e) => set('minutes', e.target.value)}
              slotProps={{ htmlInput: { min: limits.minMinutes, max: limits.maxMinutes } }} helperText={`At least ${limits.minMinutes}.`} />
          )}
          {value.type === 'weekly' && (
            <TextField select label="Day" value={value.day} disabled={disabled} sx={{ minWidth: 150 }} onChange={(e) => set('day', e.target.value)}>
              {DAY_NAMES.map((d, n) => <MenuItem key={d} value={n}>{d}</MenuItem>)}
            </TextField>
          )}
          {value.type === 'monthly' && (
            <TextField label="Day of the month" type="number" value={value.day} disabled={disabled} sx={{ width: 160 }} onChange={(e) => set('day', e.target.value)}
              slotProps={{ htmlInput: { min: 1, max: 28 } }} helperText="1 to 28." />
          )}
          {['daily', 'weekdays', 'weekly', 'monthly', 'custom'].includes(value.type) && (
            <TextField label="Time (UTC)" type="time" value={value.at} disabled={disabled} onChange={(e) => set('at', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          )}
        </Stack>
        {value.type === 'custom' && (
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Repeat every" type="number" value={value.every} disabled={disabled} sx={{ width: 140 }} onChange={(e) => set('every', e.target.value)}
                slotProps={{ htmlInput: { min: 1, max: limits.customUnits[value.unit] } }} helperText={`1 to ${limits.customUnits[value.unit]}.`} />
              <TextField select label="Unit" value={value.unit} disabled={disabled} sx={{ minWidth: 140 }}
                onChange={(e) => onChange({ ...value, unit: e.target.value, every: 1 })}>
                {Object.entries(UNIT_NAMES).map(([u, label]) => <MenuItem key={u} value={u}>{label}</MenuItem>)}
              </TextField>
            </Stack>
            {value.unit === 'week' && (
              <FormGroup row aria-label="Days of the week">
                {DAY_NAMES.map((d, n) => (
                  <FormControlLabel key={d} label={d.slice(0, 3)} control={<Checkbox checked={value.days.includes(n)} disabled={disabled} inputProps={{ 'aria-label': d }}
                    onChange={() => set('days', value.days.includes(n) ? value.days.filter((x) => x !== n) : [...value.days, n].sort())} />} />
                ))}
              </FormGroup>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Starts on" type="date" value={value.starts_on} disabled={disabled} onChange={(e) => set('starts_on', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
              <TextField label="Ends on" type="date" value={value.ends_on} disabled={disabled} onChange={(e) => set('ends_on', e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }} helperText="Optional." />
            </Stack>
          </Stack>
        )}
        <ValueTable value={value.inputs || []} names={names} disabled={disabled} addLabel="Add an input value"
          onChange={(inputs) => set('inputs', inputs)}
          helperText="The values the scheduled run is started with. A blank value is not set." />
        {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
        {!disabled && <Button color="error" onClick={onRemove} sx={{ alignSelf: 'flex-start' }}>Remove this schedule</Button>}
      </Stack>
    </Box>
  );
}
