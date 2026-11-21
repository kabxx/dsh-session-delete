import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withDeleteLocks } from './delete-disk.js';
import { captureDirectory, withDirectoryLocks } from './delete-tree.js';
import { directoryTree, withFileLock } from './online-disk.js';
import { publishPath, syncDirectory } from './platform-fs.js';
import { idleWebWriter, releaseIdleWebWriters } from './idle-web-writer.js';
import { removeStaleProjection } from './stale-projection.js';
import { cleanStaleSearch, configuredDisabledSearchPath } from './stale-search.js';

const ticketLifetime = 5 * 60_000;
const maxTickets = 64;
const knownErrors = new Set([
  'busy', 'locked', 'unsupported', 'unsafe-path', 'cross-device', 'collision', 'missing',
  'changed', 'dependent-fork', 'cleanup-pending', 'authentication-required', 'bad-request',
]);

function fail(code) {
  throw Object.assign(new Error(`Session delete (${code})`), { code });
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f]/u.test(id);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function writeJournal(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(state), 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await publishPath(temporary, path, { replace: true });
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function validateEntry(entry) {
  if (![1, 2].includes(entry?.version) || (entry.version === 2 && typeof entry.transaction !== 'string')
    || !Array.isArray(entry.members) || entry.members.length === 0
    || entry.members.some((member) => !validId(member?.id))) fail('cleanup-pending');
  return entry;
}

async function readEntries(journal) {
  const state = await readJson(journal);
  if (state === undefined || ([1, 2].includes(state?.version) && state.members === null)) return [];
  if (state?.version === 3 && Array.isArray(state.entries)) return state.entries.map(validateEntry);
  return [validateEntry(state)];
}

function writeEntries(journal, entries) {
  return writeJournal(journal, { version: 3, entries });
}

/** Follow durable creator edges. A normal fork can name the same parent. */
function scope(root, stored, live) {
  const headers = new Map(stored.map(({ header }) => [header.id, header]));
  for (const session of live) headers.set(session.id, session.header);
  if (!headers.has(root)) fail('missing');
  const children = new Map();
  for (const header of headers.values()) {
    if (header.origin !== 'subagent' || !header.parentSession) continue;
    const siblings = children.get(header.parentSession) ?? [];
    siblings.push(header.id);
    children.set(header.parentSession, siblings);
  }
  const ids = new Set([root]);
  for (const parent of ids) {
    for (const child of children.get(parent) ?? []) {
      if (ids.has(child)) fail('unsupported');
      ids.add(child);
    }
  }
  return [...ids].sort();
}

function samePlan(a, b) {
  return a.length === b.length && a.every((member, index) => {
    const other = b[index];
    return member.id === other.id && member.relative === other.relative
      && member.identity.dev === other.identity.dev && member.identity.ino === other.identity.ino;
  });
}

export function createSessionDelete(ctx, { root, journal, legacyTrash }) {
  const staging = join(dirname(journal), 'directory-deletion');
  const registry = ctx.workspaceRegistry;
  const tickets = new Map();
  let chain = Promise.resolve();

  async function assertInactive(ids, allowResident = false) {
    for (const sessionId of ids) {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, async () => []);
      if (activity.length > 0) fail('busy');
    }
    const targets = new Set(ids);
    return ctx.sessions.list().filter(({ id }) => targets.has(id)).map((session) => {
      if (!allowResident) fail('locked');
      return idleWebWriter(ctx, session);
    });
  }

  async function describe(id, entries, allowResident = false) {
    const stored = await ctx.sessionPersistence.list();
    const ids = scope(id, stored, ctx.sessions.list());
    const targets = new Set(ids);
    if (entries.some(({ members }) => members.some(({ id }) => targets.has(id)))) fail('cleanup-pending');
    const writers = await assertInactive(ids, allowResident);
    if (stored.some(({ header, formatStatus }) => formatStatus === 'migration-required'
      && !targets.has(header.id) && targets.has(header.parentSession))) fail('dependent-fork');
    const legacy = await readJson(legacyTrash);
    // Earlier Trash versions may have removed some of a group's logs already.
    // Refuse an overlapping delete while that data is reserved by the old journal.
    if (legacy?.entries?.some((entry) => entry.kind === 'disk'
      && entry.members?.some(({ id }) => targets.has(id)))) fail('changed');
    const members = [];
    for (const memberId of ids) {
      const snapshot = await ctx.sessionPersistence.stat(memberId);
      if (!snapshot?.location) fail('unsupported');
      members.push(await captureDirectory(root, memberId, snapshot.location));
    }
    return { members, writers };
  }

  async function removeNativeRecords(members) {
    const ids = members.map(({ id }) => id);
    const cache = ctx.get('storageDomain')?.get('session_projcache')?.table('sessions');
    for (const id of ids) {
      for (const workspace of registry.list()) {
        if (workspace.sessionIds.includes(id)) await registry.get(workspace.id).detachSession(id);
      }
      await registry.unpinSession(id);
      await registry.unarchiveSession(id);
      if (cache) await cache.delete(id);
    }
    if (!cache) await removeStaleProjection(ctx, ids);
    const query = ctx.get('sessionQuery');
    if (query?.config?.openAt === 'never' || !query) {
      await cleanStaleSearch(configuredDisabledSearchPath(ctx, query), ids);
    } else if (typeof query.searchSessions === 'function') {
      const { openAt, path } = query.config ?? {};
      if (openAt === 'first-search' && typeof path === 'string' && path !== ':memory:') {
        // DSH opens (and creates) the configured database on its first search.
        // Deleting a session should not initialize an absent on-disk index.
        try {
          await stat(path);
        } catch (error) {
          if (error.code === 'ENOENT') return;
          throw error;
        }
      }
      // Reconciliation runs before DSH executes the required non-empty search query.
      await query.searchSessions({ query: 'session', limit: 1 });
    }
  }

  async function finish(members) {
    // A newly created session of the same ID must keep its native records.
    for (const { id } of members) {
      if (await ctx.sessionPersistence.stat(id)) fail('changed');
    }
    for (const { id } of members) ctx.emit('api-session/removed', id);
    await removeNativeRecords(members);
  }

  async function recoverForPreview(id, entries) {
    const entry = entries.find(({ members }) => members.some((member) => member.id === id));
    if (!entry) return entries;
    const remaining = entries.filter((pending) => pending !== entry);
    try {
      const complete = async (lease) => {
        await assertInactive(entry.members.map(({ id }) => id));
        await lease.remove();
        await finish(entry.members);
        await writeEntries(journal, remaining);
      };
      if (entry.version === 1) {
        await withDeleteLocks({ root, members: entry.members, committed: true }, complete);
      } else {
        await withDirectoryLocks({ root, staging, members: entry.members, transaction: entry.transaction }, complete);
      }
    } catch (error) {
      ctx.logger.warn('Session delete recovery: %s', error);
      fail('cleanup-pending');
    }
    return remaining;
  }

  function sessionCookie(request) {
    return createHash('sha256').update(request.headers.get('cookie') ?? '').digest('hex');
  }

  async function preview(id, request, entries) {
    const { members, writers } = await describe(id, entries, true);
    const previewResidents = new Set(writers.map(({ session }) => session.id));
    return withDirectoryLocks({ root, staging, members, previewResidents }, async (lease) => {
      const current = await describe(id, entries, true);
      if (!samePlan(members, current.members) || current.writers.some(({ session }) => !previewResidents.has(session.id))) fail('changed');
      const ticket = randomUUID();
      const now = Date.now();
      for (const [key, record] of tickets) if (record.expires <= now) tickets.delete(key);
      if (tickets.size >= maxTickets) tickets.delete(tickets.keys().next().value);
      tickets.set(ticket, { id, members, files: lease.fingerprint, cookie: sessionCookie(request), expires: now + ticketLifetime });
      return { ticket, count: members.length - 1 };
    });
  }

  async function remove(id, ticket, request, entries) {
    const expected = tickets.get(ticket);
    if (expected?.id !== id || expected.expires <= Date.now() || expected.cookie !== sessionCookie(request)) fail('changed');
    tickets.delete(ticket);
    const { members, writers } = await describe(id, entries, true);
    if (!samePlan(expected.members, members)) fail('changed');
    if (writers.length > 0) {
      const previewResidents = new Set(writers.map(({ session }) => session.id));
      await withDirectoryLocks({ root, staging, members, previewResidents }, ({ fingerprint }) => {
        if (expected.files !== fingerprint) fail('changed');
        request.signal.throwIfAborted();
        return releaseIdleWebWriters(ctx, writers);
      });
    }
    let diskRemoved = false;
    try {
      await withDirectoryLocks({ root, staging, members }, async (lease) => {
        if (expected.files !== lease.fingerprint) fail('changed');
        await lease.remove(async (plan) => {
          if (!samePlan(members, (await describe(id, entries)).members)) fail('changed');
          request.signal.throwIfAborted();
          await writeEntries(journal, [...entries, { version: 2, ...plan }]);
        });
        diskRemoved = true;
        await finish(members);
        await writeEntries(journal, entries);
      });
    } catch (error) {
      if (!diskRemoved) throw error;
      ctx.logger.warn('Session delete record cleanup: %s', error);
      return { deleted: true, cleanupPending: true };
    }
    return { deleted: true };
  }

  return (request) => {
    const result = chain.then(async () => {
      const headers = { 'Cache-Control': 'no-store' };
      try {
        if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          fail('bad-request');
        }
        let body;
        try { body = await request.json(); } catch { fail('bad-request'); }
        if (!validId(body?.id) || (body.action !== 'preview' && (body.action !== 'delete'
          || typeof body.ticket !== 'string' || body.ticket.length !== 36))) fail('bad-request');
        await directoryTree(dirname(journal), true);
        const value = await withFileLock(`${journal}.lock`, async () => {
          // The exact fetch route already enforces DSH's owner admission policy.
          const entries = await readEntries(journal);
          // Only a preview for a member of a previously confirmed group may resume its cleanup.
          if (body.action === 'preview') return preview(body.id, request, await recoverForPreview(body.id, entries));
          return remove(body.id, body.ticket, request, entries);
        });
        return Response.json(value, { headers });
      } catch (error) {
        const code = knownErrors.has(error.code) ? error.code : 'failed';
        if (code === 'failed') ctx.logger.warn('Session delete: %s', error);
        const status = code === 'bad-request' ? 400 : code === 'authentication-required' ? 403 : code === 'failed' ? 500 : 409;
        return Response.json({ error: code }, { headers, status });
      }
    });
    chain = result.then(() => {}, () => {});
    return result;
  };
}
