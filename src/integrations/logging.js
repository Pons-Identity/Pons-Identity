const db = require('../db');
const appSettings = require('../app-settings');

// The logging settings: which log.*() lines are kept, whether output() lines are kept too, and how long kept lines are kept.
// They also hold the colors a line gets when its script did not pick one.
//
// Two different things are written, and they are kept apart on purpose:
//   - output(): what the script prints for the run. It is shown on the run's page (its Output section) and is kept with the
//     run history. It is saved to the files module only when "Also save output" is on.
//   - log.*(): what the script logs, at a level. It is shown on the run's page (its Log section) and, when the level is at or
//     above "save from", written to the files module under /logs/integration-<id>/ for later retrieval (files/logs.js).
// Saved lines age out by "keep for" days: the global setting, or the integration's own when it sets one.

const LEVELS = ['debug', 'normal', 'warning', 'error'];
const LEVEL_LABELS = { debug: 'Debug', normal: 'Normal', warning: 'Warning', error: 'Error' };
// Older runs recorded 'log' and 'warn'.
const LEGACY = { log: 'normal', warn: 'warning', info: 'normal' };
const COLORS = ['default', 'grey', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'cyan'];
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const DEFAULTS = {
  saveLevel: 'off', // 'off' or the lowest level to save
  saveOutput: false,
  retentionDays: 30, // 0 keeps saved logs until someone deletes them
  colors: { debug: 'grey', normal: 'default', warning: 'orange', error: 'red', output: 'default' },
};
const KEY = 'integration_logging';

const levelOf = (l) => (LEVELS.includes(l) ? l : LEGACY[l] || 'normal');
const validColor = (c) => typeof c === 'string' && (COLORS.includes(c.toLowerCase()) || HEX.test(c));
const normalizeColor = (c) => (typeof c === 'string' && COLORS.includes(c.toLowerCase()) ? c.toLowerCase() : c);

const get = () => {
  const saved = appSettings.read(KEY) || {};
  return { ...DEFAULTS, ...saved, colors: { ...DEFAULTS.colors, ...(saved.colors || {}) } };
};

const retentionProblem = (days) => (Number.isInteger(days) && days >= 0 && days <= 3650 ? null : 'Keep saved lines for 0 to 3650 days (0 keeps them until someone deletes them).');

/** Validates the settings form. Returns { data, errors }. */
function parse(body) {
  const errors = [];
  const saveLevel = body.saveLevel === 'off' || LEVELS.includes(body.saveLevel) ? body.saveLevel : 'off';
  const retentionDays = Number(body.retentionDays);
  const problem = retentionProblem(retentionDays);
  if (problem) errors.push(problem);
  const colors = {};
  for (const k of [...LEVELS, 'output']) {
    const c = (body.colors || {})[k];
    if (c === undefined || c === '') { colors[k] = DEFAULTS.colors[k]; continue; }
    if (!validColor(c)) errors.push(`The ${k} color must be one of ${COLORS.join(', ')} or a hex color such as #b3261e.`);
    else colors[k] = normalizeColor(c);
  }
  return { errors, data: { saveLevel, saveOutput: Boolean(body.saveOutput), retentionDays, colors } };
}

const save = (data) => appSettings.write(KEY, data);

/** The color a line gets when its script did not pick one. */
const defaultColor = (stream, level, cfg = get()) => (stream === 'output' ? cfg.colors.output : cfg.colors[levelOf(level)]);

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** An integration's own logging settings ({ saveLevel, saveOutput, retentionDays }), or null when it follows the global ones. */
const overrideOf = (integrationId) => {
  const row = db.get('SELECT logging FROM integrations WHERE id = ?', Number(integrationId));
  return row ? parseJson(row.logging) : null;
};

/** The settings that apply to one integration: its own, over the global ones. Colors always come from the global settings. */
function effective(integrationId, base = get()) {
  const o = overrideOf(integrationId);
  return o ? { ...base, saveLevel: o.saveLevel, saveOutput: o.saveOutput, retentionDays: o.retentionDays } : base;
}

/**
 * Validates an integration's logging settings from its form. `null`, nothing, or { inherit: true } follows the global settings.
 * Returns { errors, value } where value is the JSON text to store ('' for the global settings).
 */
function parseOverride(body) {
  if (body === undefined || body === null || body.inherit !== false) return { errors: [], value: '' };
  const saveLevel = body.saveLevel === 'off' || LEVELS.includes(body.saveLevel) ? body.saveLevel : 'off';
  const retentionDays = Number(body.retentionDays);
  const problem = retentionProblem(retentionDays);
  return { errors: problem ? [problem.replace('Keep saved lines', 'Keep this integration\'s saved lines')] : [], value: JSON.stringify({ saveLevel, saveOutput: Boolean(body.saveOutput), retentionDays }) };
}

/** What the console shows for an integration's logging: { inherit: true } or its own settings. */
function overrideView(integrationId) {
  const o = overrideOf(integrationId);
  return o ? { inherit: false, ...o } : { inherit: true };
}

module.exports = { effective, parseOverride, overrideView, overrideOf, LEVELS, LEVEL_LABELS, COLORS, DEFAULTS, levelOf, validColor, normalizeColor, get, parse, save, defaultColor };
