const { WsError } = require('./grouper-ws');

// Pushes the export model (grouper-export.js) to a live Grouper over its web services. Writes are idempotent
// (groups are saved, members already present are left alone), so a failed or cancelled run can simply be run again.
// Composite groups have no REST operation; they are reported so they can be applied with the generated GSH script.

const BATCH = 100;
const GROUP_BATCH = 50;
const FAILURE_CAP = 200;
const GROUP_SOURCE = 'g:gsa';
const ALL_SOURCE = 'g:isa'; // Grouper's internal subjects, which include "GrouperAll"

const LOOKUP_BY = ['subjectId', 'subjectIdentifier'];

function parseOptions(raw = {}) {
  const lookupBy = raw.lookupBy || 'subjectId';
  const subjectSourceId = String(raw.subjectSourceId || '').trim();
  const timeZone = String(raw.timeZone || 'UTC').trim();
  const errors = [];
  if (!LOOKUP_BY.includes(lookupBy)) errors.push('Look people up by subject ID or subject identifier.');
  if (subjectSourceId && !/^[A-Za-z0-9_.:-]{1,64}$/.test(subjectSourceId)) errors.push('The subject source ID may only use letters, numbers and . _ : -');
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { errors.push('Unknown time zone. Use a name such as UTC or America/New_York.'); }
  return { options: { lookupBy, subjectSourceId, timeZone }, errors };
}

// Grouper reads enabledTime / disabledTime as "yyyy/MM/dd HH:mm:ss.SSS" in its own time zone.
function formatTime(sec, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(sec * 1000)).map((p) => [p.type, p.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.000`;
}

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const lookupFor = (subject, o) => ({ [o.lookupBy]: subject, ...(o.subjectSourceId ? { subjectSourceId: o.subjectSourceId } : {}) });

/** Read-only check: does Grouper answer, and can it find the people the export refers to? */
async function preflight(ws, model, rawOptions) {
  const { options, errors } = parseOptions(rawOptions);
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { errors });
  const subjects = [...new Set([
    ...model.memberships.map((m) => m.subject),
    ...model.privileges.filter((p) => p.subject_type === 'user').map((p) => p.subject),
  ])];
  const notFound = [];
  let found = 0;
  for (const batch of chunks(subjects, BATCH)) {
    const results = await ws.getSubjects(batch.map((s) => lookupFor(s, options)));
    results.forEach((r, i) => {
      if (r.found) found += 1;
      else notFound.push({ subject: batch[i], code: r.code });
    });
  }
  return { checked: subjects.length, found, notFound: notFound.slice(0, 100), notFoundCount: notFound.length };
}

/**
 * Applies the model. hooks.progress(phase, done, total) reports headway; hooks.cancelled() stops between requests.
 * Resolves with a report; throws WsError only for an authentication failure, which would repeat on every request.
 */
async function run(ws, model, rawOptions, hooks = {}) {
  const { options, errors } = parseOptions(rawOptions);
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { errors });

  const report = {
    state: 'done',
    phases: { groups: { ok: 0, failed: 0 }, members: { ok: 0, failed: 0 }, nested: { ok: 0, failed: 0 }, privileges: { ok: 0, failed: 0 } },
    groupCodes: {},
    failures: [],
    failureCount: 0,
    notPushed: { composites: model.composites.map((c) => ({ group: c.group, type: c.grouper_op, left: c.left, right: c.right })) },
  };
  const fail = (phase, target, code) => {
    report.phases[phase].failed += 1;
    report.failureCount += 1;
    if (report.failures.length < FAILURE_CAP) report.failures.push({ phase, target, code });
  };
  const ok = (phase, n = 1) => { report.phases[phase].ok += n; };
  const stopped = () => hooks.cancelled && hooks.cancelled();
  const progress = (phase, done, total) => hooks.progress && hooks.progress(phase, done, total);

  // Runs one request; a transport failure fails every item in it but lets the run continue. Auth failures abort.
  async function attempt(phase, targets, fn) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof WsError) || err.auth) throw err;
      for (const t of targets) fail(phase, t, err.message);
      return null;
    }
  }

  const saved = new Map(); // grouper name -> uuid
  try {
    /* 1. Groups (this also creates any missing folders) */
    let done = 0;
    for (const batch of chunks(model.groups, GROUP_BATCH)) {
      if (stopped()) { report.state = 'cancelled'; return report; }
      const results = await attempt('groups', batch.map((g) => g.name), () => ws.saveGroups(batch));
      if (results) {
        results.forEach((r, i) => {
          report.groupCodes[r.code] = (report.groupCodes[r.code] || 0) + 1;
          if (r.ok) { saved.set(batch[i].name, r.uuid); ok('groups'); } else fail('groups', batch[i].name, r.code);
        });
      }
      done += batch.length;
      progress('groups', done, model.groups.length);
    }

    /* 2. Direct members, with membership dates where set */
    const buckets = new Map(); // "group|start|end" -> { group, start, end, rows }
    for (const m of model.memberships) {
      if (!saved.has(m.group)) { fail('members', `${m.group}: ${m.username}`, 'group was not created'); continue; }
      const key = `${m.group}|${m.start_at || ''}|${m.end_at || ''}`;
      if (!buckets.has(key)) buckets.set(key, { group: m.group, start: m.start_at, end: m.end_at, rows: [] });
      buckets.get(key).rows.push(m);
    }
    done = 0;
    for (const b of buckets.values()) {
      for (const batch of chunks(b.rows, BATCH)) {
        if (stopped()) { report.state = 'cancelled'; return report; }
        const window = {};
        if (b.start) window.enabledTime = formatTime(b.start, options.timeZone);
        if (b.end) window.disabledTime = formatTime(b.end, options.timeZone);
        const results = await attempt('members', batch.map((m) => `${b.group}: ${m.username}`),
          () => ws.addMembers(b.group, batch.map((m) => lookupFor(m.subject, options)), window));
        if (results) results.forEach((r, i) => (r.ok ? ok('members') : fail('members', `${b.group}: ${batch[i].username}`, r.code)));
        done += batch.length;
        progress('members', done, model.memberships.length);
      }
    }

    /* 3. Nested groups: the child is a member of the parent through the group subject source */
    const byParent = new Map();
    for (const i of model.includes) {
      if (!saved.has(i.group)) { fail('nested', `${i.group} ⊃ ${i.member_group}`, 'group was not created'); continue; }
      if (!byParent.has(i.group)) byParent.set(i.group, []);
      byParent.get(i.group).push(i.member_group);
    }
    done = 0;
    for (const [parent, children] of byParent) {
      for (const batch of chunks(children, BATCH)) {
        if (stopped()) { report.state = 'cancelled'; return report; }
        const lookups = batch.map((name) => (saved.get(name)
          ? { subjectSourceId: GROUP_SOURCE, subjectId: saved.get(name) }
          : { subjectSourceId: GROUP_SOURCE, subjectIdentifier: name }));
        const results = await attempt('nested', batch.map((c) => `${parent} ⊃ ${c}`), () => ws.addMembers(parent, lookups));
        if (results) results.forEach((r, i) => (r.ok ? ok('nested') : fail('nested', `${parent} ⊃ ${batch[i]}`, r.code)));
        done += batch.length;
        progress('nested', done, model.includes.length);
      }
    }

    /* 4. Delegated privileges, one request per group and privilege */
    const grants = new Map(); // "group|privilege" -> { group, privilege, rows }
    for (const p of model.privileges) {
      if (!saved.has(p.group)) { fail('privileges', `${p.group}: ${p.privilege} to ${p.subject}`, 'group was not created'); continue; }
      const key = `${p.group}|${p.privilege}`;
      if (!grants.has(key)) grants.set(key, { group: p.group, privilege: p.privilege, rows: [] });
      grants.get(key).rows.push(p);
    }
    done = 0;
    for (const g of grants.values()) {
      for (const batch of chunks(g.rows, BATCH)) {
        if (stopped()) { report.state = 'cancelled'; return report; }
        const lookups = batch.map((p) => {
          if (p.subject_type === 'group') return { subjectSourceId: GROUP_SOURCE, subjectIdentifier: p.subject };
          if (p.subject_type === 'everyone') return { subjectSourceId: ALL_SOURCE, subjectId: p.subject };
          return lookupFor(p.subject, options);
        });
        const r = await attempt('privileges', batch.map((p) => `${g.group}: ${g.privilege} to ${p.subject}`),
          () => ws.assignPrivileges(g.group, lookups, [g.privilege]));
        if (r) { if (r.ok) ok('privileges', batch.length); else for (const p of batch) fail('privileges', `${g.group}: ${g.privilege} to ${p.subject}`, r.code); }
        done += batch.length;
        progress('privileges', done, model.privileges.length);
      }
    }
  } catch (err) {
    if (err instanceof WsError && err.auth) {
      report.state = 'failed';
      report.error = err.message;
      return report;
    }
    throw err;
  }
  return report;
}

module.exports = { parseOptions, formatTime, preflight, run, LOOKUP_BY };
