const net = require('net');

// A small client for the Internet2 Grouper web services REST API (grouper-ws/servicesRest/<version>/...).
// Requests are JSON with HTTP Basic authentication. Every operation answers with an X-Grouper-resultCode
// header and per-item result codes in the body; callers get those back rather than exceptions, except for
// transport problems and authentication failures, which throw WsError. Credentials never appear in errors.

class WsError extends Error {
  constructor(message, { status = 0, auth = false } = {}) {
    super(message);
    this.name = 'WsError';
    this.status = status;
    this.auth = auth;
  }
}

const VERSION_RE = /^v\d+_\d+_\d+$/;
const isLoopback = (host) => host === 'localhost' || host === '[::1]' || /^127\./.test(host);

/** Validates the service URL and API version; returns the base URL (no trailing slash). Throws Error with a message for the admin. */
function parseTarget(rawUrl, version) {
  let u;
  try { u = new URL(String(rawUrl || '').trim()); } catch { throw new Error('Enter the Grouper web services URL, for example https://grouper.example.net/grouper-ws/servicesRest.'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('The URL must start with https://.');
  if (u.protocol === 'http:' && !isLoopback(u.hostname)) throw new Error('Use https:// so the password is not sent in the clear.');
  if (u.username || u.password) throw new Error('Do not put the username or password in the URL.');
  if (u.search || u.hash) throw new Error('The URL must not have a query string or fragment.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if ((net.isIPv4(host) && /^169\.254\./.test(host)) || (net.isIPv6(host) && /^fe80:/i.test(host)) || /^metadata\.|\.internal$/i.test(host)) {
    throw new Error('That address is not allowed.');
  }
  if (!VERSION_RE.test(version || '')) throw new Error('The API version looks like v2_5_000.');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/${version}`;
}

class GrouperWs {
  constructor({ baseUrl, username, password, timeoutMs = 30000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl;
    this.auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async call(method, path, rootName, body) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        redirect: 'error', // a redirect would carry the credentials to another host
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: this.auth, 'content-type': 'application/json; charset=UTF-8', accept: 'application/json' },
        body: JSON.stringify({ [rootName]: body }),
      });
    } catch (err) {
      const why = err.name === 'TimeoutError' ? 'timed out' : (err.cause && err.cause.code) || 'could not be reached';
      throw new WsError(`Grouper ${why}.`);
    }
    if (res.status === 401 || res.status === 403) throw new WsError('Grouper rejected the username or password, or that account may not use web services.', { status: res.status, auth: true });
    if (res.status === 404) throw new WsError('Grouper web services were not found at that URL and version.', { status: 404 });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!json) throw new WsError(`Grouper answered with an unexpected response (HTTP ${res.status}).`, { status: res.status });
    return {
      http: res.status,
      resultCode: res.headers.get('x-grouper-resultcode') || '',
      success: res.headers.get('x-grouper-success') === 'T',
      body: json,
    };
  }

  /** Looks people up. Returns one { found, code } per lookup, in order. */
  async getSubjects(lookups) {
    const r = await this.call('POST', '/subjects', 'WsRestGetSubjectsRequest', { wsSubjectLookups: lookups });
    const rows = r.body.WsGetSubjectsResults?.wsSubjects || [];
    if (rows.length !== lookups.length) throw new WsError('Grouper returned a different number of people than were asked for.', { status: r.http });
    return rows.map((s) => ({ found: s.success === 'T' && s.resultCode === 'SUCCESS', code: s.resultCode || 'UNKNOWN', id: s.id || '', sourceId: s.sourceId || '' }));
  }

  /** Reads groups' current members (immediate and effective). Returns { found, code, members: [{ id, sourceId }] } per group, in order. */
  async getMembers(groupNames) {
    const r = await this.call('POST', '/groups', 'WsRestGetMembersRequest', { wsGroupLookups: groupNames.map((groupName) => ({ groupName })) });
    const rows = r.body.WsGetMembersResults?.results;
    if (!rows) throw new WsError(`Grouper could not list members (${r.resultCode || `HTTP ${r.http}`}).`, { status: r.http });
    const byName = new Map(rows.filter((x) => x.wsGroup?.name).map((x) => [x.wsGroup.name, x]));
    return groupNames.map((name, i) => {
      const x = byName.get(name) || (rows.length === groupNames.length && !rows[i].wsGroup?.name ? rows[i] : null);
      if (!x) return { found: false, code: 'GROUP_NOT_FOUND', members: [] };
      return {
        found: x.resultMetadata?.success === 'T',
        code: x.resultMetadata?.resultCode || 'UNKNOWN',
        members: (x.wsSubjects || []).filter((m) => m.success !== 'F').map((m) => ({ id: m.id, sourceId: m.sourceId || '' })),
      };
    });
  }

  /** Creates or updates groups (and any missing parent folders). Returns { ok, code, uuid } per group, in order. */
  async saveGroups(groups) {
    const r = await this.call('POST', '/groups', 'WsRestGroupSaveRequest', {
      wsGroupToSaves: groups.map((g) => ({
        wsGroup: { name: g.name, extension: g.extension, displayExtension: g.extension, description: g.description || '' },
        wsGroupLookup: { groupName: g.name },
        saveMode: 'INSERT_OR_UPDATE',
        createParentStemsIfNotExist: 'T',
      })),
    });
    const rows = r.body.WsGroupSaveResults?.results;
    if (!rows || rows.length !== groups.length) throw new WsError(`Grouper could not save the groups (${r.resultCode || `HTTP ${r.http}`}).`, { status: r.http });
    return rows.map((x) => ({
      ok: x.resultMetadata?.success === 'T',
      code: x.resultMetadata?.resultCode || 'UNKNOWN',
      uuid: x.wsGroup?.uuid || '',
    }));
  }

  /** Adds direct members to a group. `window` may carry enabledTime / disabledTime strings. Returns { ok, code } per lookup. */
  async addMembers(groupName, lookups, window = {}) {
    const r = await this.call('PUT', `/groups/${encodeURIComponent(groupName)}/members`, 'WsRestAddMemberRequest', {
      subjectLookups: lookups,
      replaceAllExisting: 'F',
      ...(window.enabledTime ? { enabledTime: window.enabledTime } : {}),
      ...(window.disabledTime ? { disabledTime: window.disabledTime } : {}),
    });
    const rows = r.body.WsAddMemberResults?.results;
    if (!rows || rows.length !== lookups.length) {
      throw new WsError(`Grouper could not add members to ${groupName} (${r.resultCode || `HTTP ${r.http}`}).`, { status: r.http });
    }
    return rows.map((x) => ({ ok: x.resultMetadata?.success === 'T', code: x.resultMetadata?.resultCode || 'UNKNOWN' }));
  }

  /** Grants group privileges (admin, update, read, view) to subjects. Returns { ok, code } for the whole request. */
  async assignPrivileges(groupName, lookups, privilegeNames) {
    const r = await this.call('POST', '/grouperPrivileges', 'WsRestAssignGrouperPrivilegesRequest', {
      allowed: 'T',
      privilegeType: 'access',
      privilegeNames,
      wsGroupLookup: { groupName },
      wsSubjectLookups: lookups,
      replaceAllExisting: 'F',
    });
    const rows = r.body.WsAssignGrouperPrivilegesResults?.results;
    if (!rows) throw new WsError(`Grouper could not assign privileges on ${groupName} (${r.resultCode || `HTTP ${r.http}`}).`, { status: r.http });
    const bad = rows.find((x) => x.resultMetadata?.success !== 'T');
    return { ok: !bad, code: bad ? bad.resultMetadata?.resultCode || 'UNKNOWN' : 'SUCCESS' };
  }
}

module.exports = { GrouperWs, WsError, parseTarget };
