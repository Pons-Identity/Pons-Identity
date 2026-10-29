// When a scheduled integration runs. Times are UTC so a server's time zone cannot move a job. Shapes:
//   { type: 'interval', minutes }        every N minutes (5 to 10080)
//   { type: 'daily', at: 'HH:MM' }
//   { type: 'weekdays', at: 'HH:MM' }    Monday to Friday
//   { type: 'weekly', day: 0-6, at: 'HH:MM' }   day 0 is Sunday
//   { type: 'monthly', day: 1-28, at: 'HH:MM' }
//   { type: 'custom', unit, every, at: 'HH:MM', starts_on: 'YYYY-MM-DD', ends_on: 'YYYY-MM-DD' or '', days: [0-6] }
//       unit 'minute', 'hour' or 'day': every N of them, counted from starts_on at `at` (days is empty)
//       unit 'week': on the chosen days of every Nth week, counting weeks (Sunday to Saturday) from the one holding starts_on

const MIN_MINUTES = 5;
const MAX_MINUTES = 7 * 24 * 60;
const MAX_PER_INTEGRATION = 10;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// How far "every N" may go for each custom unit. A minute can be as short as one, unlike an interval.
const CUSTOM_UNITS = { minute: { max: 59, ms: 60000 }, hour: { max: 23, ms: 3600000 }, day: { max: 365, ms: 86400000 }, week: { max: 52 } };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const inputValues = require('./inputs');

const validDate = (v) => typeof v === 'string' && DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/**
 * Returns { schedule (object or null), errors } for a submitted value. `inputs`, when given, are the values the scheduled run is
 * started with: each { name, type, value } (see inputs.js). They are kept only when there are some, so a schedule without any
 * is stored exactly as before.
 */
function parse(body) {
  const { schedule, errors } = parseShape(body);
  if (!schedule) return { schedule, errors };
  const values = inputValues.parseValues(body.inputs);
  if (values.errors.length) return { schedule: null, errors: values.errors };
  return { schedule: values.rows.length ? { ...schedule, inputs: values.rows } : schedule, errors: [] };
}

function parseShape(body) {
  if (body === undefined || body === null || body === '' || body.type === 'none') return { schedule: null, errors: [] };
  if (typeof body !== 'object') return { schedule: null, errors: ['The schedule is not valid.'] };
  if (body.type === 'interval') {
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return { schedule: null, errors: [`An interval must be a whole number of minutes from ${MIN_MINUTES} to ${MAX_MINUTES}.`] };
    return { schedule: { type: 'interval', minutes }, errors: [] };
  }
  if (['daily', 'weekdays', 'weekly', 'monthly', 'custom'].includes(body.type)) {
    if (!AT_RE.test(body.at)) return { schedule: null, errors: ['The time of day must look like 02:30 (UTC).'] };
    if (body.type === 'daily' || body.type === 'weekdays') return { schedule: { type: body.type, at: body.at }, errors: [] };
    if (body.type === 'weekly') {
      const day = Number(body.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) return { schedule: null, errors: ['Choose a day of the week.'] };
      return { schedule: { type: 'weekly', day, at: body.at }, errors: [] };
    }
    if (body.type === 'monthly') {
      const day = Number(body.day);
      if (!Number.isInteger(day) || day < 1 || day > 28) return { schedule: null, errors: ['Choose a day of the month from 1 to 28.'] };
      return { schedule: { type: 'monthly', day, at: body.at }, errors: [] };
    }
    const unit = body.unit;
    if (!CUSTOM_UNITS[unit]) return { schedule: null, errors: ['The repeat unit must be minute, hour, day or week.'] };
    const every = Number(body.every === undefined || body.every === '' ? 1 : body.every);
    if (!Number.isInteger(every) || every < 1 || every > CUSTOM_UNITS[unit].max) return { schedule: null, errors: [`Repeat every must be a whole number from 1 to ${CUSTOM_UNITS[unit].max} ${unit}s.`] };
    let days = [];
    if (unit === 'week') {
      days = Array.isArray(body.days) ? [...new Set(body.days.map(Number))].sort((a, b) => a - b) : [];
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { schedule: null, errors: ['Choose at least one day of the week.'] };
    }
    const starts_on = body.starts_on || new Date().toISOString().slice(0, 10);
    if (!validDate(starts_on)) return { schedule: null, errors: ['The start date must look like 2026-10-31.'] };
    const ends_on = body.ends_on || '';
    if (ends_on && !validDate(ends_on)) return { schedule: null, errors: ['The end date must look like 2026-10-31.'] };
    if (ends_on && ends_on < starts_on) return { schedule: null, errors: ['The end date cannot be before the start date.'] };
    return { schedule: { type: 'custom', unit, every, at: body.at, starts_on, ends_on, days }, errors: [] };
  }
  return { schedule: null, errors: ['The schedule type must be interval, daily, weekdays, weekly, monthly or custom.'] };
}

/** The first run of a custom schedule after `from`, or '' once its end date has passed. */
function nextCustom(schedule, from) {
  const [h, m] = schedule.at.split(':').map(Number);
  const start = new Date(`${schedule.starts_on}T00:00:00Z`);
  const end = schedule.ends_on ? new Date(`${schedule.ends_on}T23:59:59Z`) : null;
  if (schedule.unit !== 'week') {
    // Minutes, hours and days count evenly from the first run, so the run times never drift.
    const first = new Date(`${schedule.starts_on}T${schedule.at}:00Z`);
    const period = schedule.every * CUSTOM_UNITS[schedule.unit].ms;
    const t = from < first ? first : new Date(first.getTime() + (Math.floor((from - first) / period) + 1) * period);
    return end && t > end ? '' : t.toISOString();
  }
  const weekStart = (d) => d.getTime() - d.getUTCDay() * DAY_MS;
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  if (day < start) day.setTime(start.getTime());
  // Within `every` weeks of any day, the chosen days come round at least once, so this always finds a run or passes the end.
  for (let i = 0; i <= schedule.every * 7 + 7; i++, day.setUTCDate(day.getUTCDate() + 1)) {
    const t = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
    if (end && t > end) return '';
    if (t <= from || !schedule.days.includes(day.getUTCDay())) continue;
    if (Math.round((weekStart(day) - weekStart(start)) / (7 * DAY_MS)) % schedule.every === 0) return t.toISOString();
  }
  return '';
}

/** The input object a scheduled run gets: its values, and when it was due. */
function inputFor(schedule, dueAt) {
  return { ...inputValues.valuesToInput(schedule.inputs || []), scheduled_for: dueAt };
}

/** The first run time after `from` (a Date), as an ISO string; '' when a schedule has ended. */
function nextRun(schedule, from = new Date()) {
  if (schedule.type === 'interval') return new Date(from.getTime() + schedule.minutes * 60000).toISOString();
  if (schedule.type === 'custom') return nextCustom(schedule, from);
  const [h, m] = schedule.at.split(':').map(Number);
  const t = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), h, m));
  if (schedule.type === 'daily') {
    if (t <= from) t.setUTCDate(t.getUTCDate() + 1);
  } else if (schedule.type === 'weekdays') {
    if (t <= from) t.setUTCDate(t.getUTCDate() + 1);
    while (t.getUTCDay() === 0 || t.getUTCDay() === 6) t.setUTCDate(t.getUTCDate() + 1);
  } else if (schedule.type === 'monthly') {
    t.setUTCDate(schedule.day);
    if (t <= from) { t.setUTCMonth(t.getUTCMonth() + 1); t.setUTCDate(schedule.day); }
  } else {
    t.setUTCDate(t.getUTCDate() + ((schedule.day - t.getUTCDay() + 7) % 7));
    if (t <= from) t.setUTCDate(t.getUTCDate() + 7);
  }
  return t.toISOString();
}

function describe(schedule) {
  if (!schedule) return '';
  if (schedule.type === 'interval') return schedule.minutes % 60 === 0 ? `Every ${schedule.minutes / 60 === 1 ? 'hour' : `${schedule.minutes / 60} hours`}` : `Every ${schedule.minutes} minutes`;
  if (schedule.type === 'daily') return `Daily at ${schedule.at} UTC`;
  if (schedule.type === 'weekdays') return `Every weekday at ${schedule.at} UTC`;
  if (schedule.type === 'monthly') return `Monthly on day ${schedule.day} at ${schedule.at} UTC`;
  if (schedule.type === 'custom') {
    const when = schedule.every === 1 ? `Every ${schedule.unit}` : `Every ${schedule.every} ${schedule.unit}s`;
    const range = `from ${schedule.starts_on}${schedule.ends_on ? ` until ${schedule.ends_on}` : ''}`;
    if (schedule.unit === 'week') return `${when} on ${schedule.days.map((d) => DAYS[d].slice(0, 3)).join(', ')} at ${schedule.at} UTC, ${range}`;
    if (schedule.unit === 'day') return `${when} at ${schedule.at} UTC, ${range}`;
    return `${when}, ${range} starting ${schedule.at} UTC`;
  }
  return `Weekly on ${DAYS[schedule.day]} at ${schedule.at} UTC`;
}

module.exports = { parse, inputFor, nextRun, describe, MIN_MINUTES, MAX_MINUTES, MAX_PER_INTEGRATION, CUSTOM_UNITS, DAYS };
