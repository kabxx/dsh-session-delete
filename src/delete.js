import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeleteLocks } from './delete-disk.js';
import { captureDirectory, withDirectoryLocks } from './delete-tree.js';
import { directoryTree, withFileLock } from './online-disk.js';
import { publishPath, syncDirectory } from './platform-fs.js';
import { idleWebWriter, releaseIdleWebWriters } from './idle-web-writer.js';
import { removeStaleProjection } from './stale-projection.js';
import { cleanStaleSearch, configuredDisabledSearchPath } from './stale-search.js';
import manifest from '../package.json' with { type: 'json' };

const recordJournal = Symbol('record journal');
const ticketLifetime = 5 * 60_000;
const maxTickets = 64;
const settlementBudget = 1200;
const defaultRecoveryDelays = [2_000, 5_000, 15_000, 30_000, 60_000];
const knownErrors = new Set([
  'busy', 'locked', 'unsupported', 'unsafe-path', 'cross-device', 'collision', 'missing',
  'changed', 'dependent-fork', 'cleanup-pending', 'restore-pending', 'recovery-pending', 'restored',
  'authentication-required', 'bad-request',
]);

export function createRecoveryLoop(recoverPending, {
  signal,
  delays = defaultRecoveryDelays,
  disposedDelay = 200,
  onError,
} = {}) {
  let attempt = 0;
  let timer = null;
  let scheduledAt = Infinity;
  let running = false;
  let rerun = false;
  let pending = false;

  function clearTimer() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    scheduledAt = Infinity;
  }

  function schedule(delayMs) {
    if (signal?.aborted) return;
    const wait = Math.max(0, delayMs);
    if (running) {
      rerun = true;
      return;
    }
    const target = performance.now() + wait;
    if (timer !== null && scheduledAt <= target) return;
    clearTimer();
    scheduledAt = target;
    timer = setTimeout(() => {
      timer = null;
      scheduledAt = Infinity;
      void run();
    }, wait);
    timer.unref?.();
  }

  async function run() {
    if (signal?.aborted || running) return;
    running = true;
    let remaining = true;
    try {
      remaining = await recoverPending(signal);
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
    }
    if (signal?.aborted) return;
    pending = Boolean(remaining);
    if (!pending) {
      attempt = 0;
      rerun = false;
      return;
    }
    if (rerun) {
      rerun = false;
      attempt = 0;
      schedule(0);
      return;
    }
    const wait = delays[Math.min(attempt, delays.length - 1)] ?? 60_000;
    attempt += 1;
    schedule(wait);
  }

  return {
    triggerNow() {
      attempt = 0;
      schedule(0);
    },
    notifyPending() {
      pending = true;
      attempt = 0;
      schedule(delays[0] ?? 2_000);
    },
    notifySessionDisposed() {
      if (!pending) return;
      attempt = 0;
      schedule(disposedDelay);
    },
    dispose() {
      clearTimer();
    },
  };
}

function fail(code) {
  throw Object.assign(new Error(`Session delete (${code})`), { code });
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024 && !/[\u0000-\u001f]/u.test(id);
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
  if (![1, 2, 3].includes(entry?.version) || (entry.version >= 2 && typeof entry.transaction !== 'string')
    || (entry.version === 3 && !['prepared', 'committed'].includes(entry.phase))
    || !Array.isArray(entry.members) || entry.members.length === 0
    || entry.members.some((member) => !validId(member?.id))) fail('cleanup-pending');
  return entry;
}

async function journalExists(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) fail('unsafe-path');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isAncestorDir(dir, target) {
  const rest = relative(dir, target);
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

async function hasJournalState(journalPath) {
  return await pathExists(journalPath)
    || await pathExists(`${journalPath}.lock`)
    || await pathExists(join(dirname(journalPath), 'directory-deletion'));
}

async function readEntries(journal) {
  if (!await journalExists(journal)) return [];
  const state = await readJson(journal);
  if (state === undefined || ([1, 2].includes(state?.version) && state.members === null)) return [];
  const entries = [3, 4].includes(state?.version) && Array.isArray(state.entries) ? state.entries : [state];
  return entries.map((entry) => ({ ...validateEntry(entry), [recordJournal]: journal }));
}

function writeEntries(journal, entries) {
  return writeJournal(journal, { version: 4, entries });
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

export function createSessionDelete(ctx, {
  root, journal, legacyJournal, legacyJournals, legacyVersionsRoot, legacyTrash, onPending,
}) {
  const staging = join(dirname(journal), 'directory-deletion');
  const configuredLegacyJournals = [...new Set([
    ...(legacyJournal ? [legacyJournal] : []),
    ...(Array.isArray(legacyJournals) ? legacyJournals : []),
  ].filter((path) => typeof path === 'string' && path !== journal))];
  const registry = ctx.workspaceRegistry;
  const tickets = new Map();
  const lastRecoveryFailure = new Map();
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

  async function describe(id, entries, signal) {
    const deadline = performance.now() + settlementBudget;
    let stored;
    let ids;
    let targets;
    let writers;
    do {
      signal?.throwIfAborted();
      stored = await ctx.sessionPersistence.list();
      ids = scope(id, stored, ctx.sessions.list());
      targets = new Set(ids);
      if (entries.some(({ members }) => members.some(({ id }) => targets.has(id)))) fail('cleanup-pending');
      writers = await assertInactive(ids, Boolean(signal));
      if (!writers.some(({ settling }) => settling)) break;
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('locked');
      await delay(Math.min(50, remaining), undefined, { signal });
    } while (true);
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

  function workspaceTable() {
    const table = ctx.get('storageDomain')?.get('workspace')?.table?.('workspaces');
    return typeof table?.get === 'function' ? table : undefined;
  }

  function rawWorkspaceSessionIds(workspace, table = workspaceTable()) {
    const stored = table?.get(workspace.id)?.sessionIds;
    return Array.isArray(stored) ? stored : undefined;
  }

  function captureWorkspacePlacements(memberIds) {
    const targetSet = new Set(memberIds);
    const placements = {};
    const table = workspaceTable();
    for (const workspace of registry.list()) {
      const ids = rawWorkspaceSessionIds(workspace, table) ?? workspace.sessionIds;
      if (!Array.isArray(ids)) continue;
      for (const memberId of memberIds) {
        const index = ids.indexOf(memberId);
        if (index === -1) continue;
        placements[memberId] = {
          workspaceId: workspace.id,
          before: ids.slice(index + 1).filter((other) => !targetSet.has(other)).slice(0, 64),
        };
      }
    }
    return Object.keys(placements).length > 0 ? placements : undefined;
  }

  async function preservePreparedWorkspaces(workspace, rawIds, entries) {
    if (!Array.isArray(rawIds) || !Array.isArray(entries)) return;
    const dirtyJournals = new Set();
    for (const entry of entries) {
      if (entry.phase !== 'prepared') continue;
      const entryIds = new Set(entry.members.map(({ id }) => id));
      let updated = false;
      for (const { id: memberId } of entry.members) {
        if (entry.workspaces?.[memberId]) continue;
        const index = rawIds.indexOf(memberId);
        if (index === -1) continue;
        entry.workspaces = {
          ...entry.workspaces,
          [memberId]: {
            workspaceId: workspace.id,
            before: rawIds.slice(index + 1).filter((other) => !entryIds.has(other)).slice(0, 64),
          },
        };
        updated = true;
      }
      if (updated && entry[recordJournal]) dirtyJournals.add(entry[recordJournal]);
    }
    for (const sourceJournal of dirtyJournals) {
      await writeEntries(sourceJournal, entries.filter((item) => item[recordJournal] === sourceJournal));
    }
  }

  async function restoreWorkspaceMembership(entry, entries) {
    const table = workspaceTable();
    const entryIds = new Set(entry.members.map(({ id }) => id));
    for (const { id: memberId } of entry.members) {
      if (!await ctx.sessionPersistence.stat(memberId)) continue;
      const saved = entry.workspaces?.[memberId];
      let workspace = saved && typeof saved.workspaceId === 'string' ? registry.get?.(saved.workspaceId) : undefined;
      let before = Array.isArray(saved?.before) ? saved.before : undefined;
      if (!workspace && !saved && table) {
        workspace = registry.list().find((candidate) => {
          const rawIds = rawWorkspaceSessionIds(candidate, table);
          return Array.isArray(rawIds) && rawIds.includes(memberId) && !candidate.sessionIds?.includes(memberId);
        });
        if (workspace) {
          const rawIds = rawWorkspaceSessionIds(workspace, table);
          const index = rawIds.indexOf(memberId);
          before = rawIds.slice(index + 1).filter((other) => !entryIds.has(other)).slice(0, 64);
        }
      }
      if (!workspace || typeof workspace.attachSession !== 'function') continue;
      if (workspace.sessionIds?.includes(memberId)) continue;
      try {
        const rawIds = rawWorkspaceSessionIds(workspace, table);
        if (Array.isArray(rawIds) && rawIds.includes(memberId)) {
          // DSH restarted while the session was staged, so the raw record still holds the ID
          // while the runtime header index omits it. Refresh membership only when the directory exists.
          if (typeof workspace.status === 'function' && await workspace.status() !== 'ok') continue;
          await preservePreparedWorkspaces(workspace, rawIds, entries);
          await workspace.detachSession?.(memberId);
        }
        await workspace.attachSession(memberId);
        if (typeof workspace.insertSessionBefore === 'function' && Array.isArray(before) && (workspace.sessionIds?.length ?? 0) > 1) {
          const anchor = before.find((candidate) => candidate !== memberId && workspace.sessionIds?.includes(candidate));
          try {
            await workspace.insertSessionBefore(memberId, anchor);
          } catch (orderError) {
            ctx.logger.warn('Session delete rollback workspace order: %s', orderError);
          }
        }
      } catch (restoreError) {
        ctx.logger.warn('Session delete rollback workspace membership: %s', restoreError);
      }
    }
  }

  async function sessionExists(id) {
    return Boolean(ctx.sessions.get(id) || await ctx.sessionPersistence.stat(id));
  }

  async function finish(members, entries) {
    // A newly created session of the same ID must keep its native records.
    // Re-check before each async step to narrow the window for concurrent same-ID recreation.
    const cache = ctx.get('storageDomain')?.get('session_projcache')?.table?.('sessions');
    const table = workspaceTable();
    const absentIds = [];
    for (const { id } of members) {
      if (await sessionExists(id)) continue;
      ctx.emit('api-session/removed', id);
      let recreated = false;
      for (const workspace of registry.list()) {
        const rawIds = rawWorkspaceSessionIds(workspace, table);
        if (Array.isArray(rawIds) && !rawIds.includes(id)) continue;
        if (await sessionExists(id)) {
          recreated = true;
          break;
        }
        await preservePreparedWorkspaces(workspace, rawIds, entries);
        const entity = registry.get ? registry.get(workspace.id) : workspace;
        await entity?.detachSession?.(id);
      }
      if (recreated || await sessionExists(id)) continue;
      await registry.unpinSession(id);
      if (await sessionExists(id)) continue;
      await registry.unarchiveSession(id);
      if (cache) {
        if (await sessionExists(id)) continue;
        await cache.delete(id);
      }
      absentIds.push(id);
    }
    if (absentIds.length === 0) return;
    if (!cache) await removeStaleProjection(ctx, absentIds);
    const query = ctx.get('sessionQuery');
    if (query?.config?.openAt === 'never' || !query) {
      const staleIds = [];
      for (const id of absentIds) {
        if (!await sessionExists(id)) staleIds.push(id);
      }
      if (staleIds.length > 0) await cleanStaleSearch(configuredDisabledSearchPath(ctx, query), staleIds);
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

  async function recoverEntry(entry, entries) {
    const sourceJournal = entry[recordJournal];
    const sourceStaging = join(dirname(sourceJournal), 'directory-deletion');
    const remaining = entries.filter((pending) => pending !== entry);
    const failureKey = `${sourceJournal}:${entry.transaction ?? entry.version}:${entry.phase ?? 'legacy'}`;
    try {
      const ids = new Set(entry.members.map(({ id }) => id));
      if (remaining.some(({ members }) => members.some(({ id }) => ids.has(id)))) fail('collision');
      // A prior rename of the journal may have succeeded before directory fsync failed.
      // Make the visible decision durable before acting on it.
      await syncDirectory(dirname(sourceJournal));
      const { members, transaction, phase } = entry;
      const directoryPlan = { root, staging: sourceStaging, members, transaction, phase };
      if (phase === 'prepared') {
        await withDirectoryLocks(directoryPlan, (lease) => lease.rollback());
        await restoreWorkspaceMembership(entry, entries);
      } else if (phase === 'committed') {
        // Committed v3 entries already detached every original directory before committing.
        // Do not let a recreated replacement session of the same ID block clearing old staging or sibling records.
        await withDirectoryLocks(directoryPlan, async (lease) => {
          await lease.remove();
          await finish(entry.members, entries);
        });
      } else {
        const complete = async (lease) => {
          await assertInactive(entry.members.map(({ id }) => id));
          await lease.remove();
          await finish(entry.members, entries);
        };
        if (entry.version === 1) {
          await withDeleteLocks({ root, members: entry.members, committed: true }, complete);
        } else {
          await withDirectoryLocks(directoryPlan, complete);
        }
      }
      await writeEntries(sourceJournal, remaining.filter((pending) => pending[recordJournal] === sourceJournal));
      lastRecoveryFailure.delete(failureKey);
    } catch (error) {
      const signature = `${error?.code ?? ''}:${error?.message ?? String(error)}`;
      if (lastRecoveryFailure.get(failureKey) !== signature) {
        lastRecoveryFailure.set(failureKey, signature);
        ctx.logger.warn('Session delete recovery: %s', error);
      }
      fail(entry.phase === 'prepared' ? 'restore-pending' : 'cleanup-pending');
    }
    return remaining;
  }

  async function recoverForPreview(id, entries) {
    const entry = entries.find(({ members }) => members.some((member) => member.id === id));
    return entry ? recoverEntry(entry, entries) : entries;
  }

  function sessionCookie(request) {
    const raw = request.headers.get('cookie') ?? '';
    const authCookies = raw.split(';')
      .map((segment) => {
        const at = segment.indexOf('=');
        if (at === -1) return null;
        const name = segment.slice(0, at).trim();
        if (!name.startsWith('dsh-auth-')) return null;
        return `${name}=${segment.slice(at + 1).trim()}`;
      })
      .filter(Boolean)
      .sort()
      .join('; ');
    return createHash('sha256').update(authCookies).digest('hex');
  }

  async function preview(id, request, entries) {
    const { members, writers } = await describe(id, entries, request.signal);
    const previewResidents = new Set(writers.map(({ session }) => session.id));
    return withDirectoryLocks({ root, staging, members, previewResidents }, async (lease) => {
      const current = await describe(id, entries, request.signal);
      if (!samePlan(members, current.members) || current.writers.some(({ session }) => !previewResidents.has(session.id))) fail('changed');
      const ticket = randomUUID();
      const now = Date.now();
      for (const [key, record] of tickets) if (record.expires <= now) tickets.delete(key);
      if (tickets.size >= maxTickets) tickets.delete(tickets.keys().next().value);
      tickets.set(ticket, { id, members, files: lease.fingerprint, cookie: sessionCookie(request), expires: now + ticketLifetime });
      return { ticket, count: members.length - 1, memberIds: members.map(({ id: memberId }) => memberId) };
    });
  }

  async function remove(id, ticket, request, entries) {
    const expected = tickets.get(ticket);
    if (expected?.id !== id || expected.expires <= Date.now() || expected.cookie !== sessionCookie(request)) fail('changed');
    tickets.delete(ticket);
    const { members, writers } = await describe(id, entries, request.signal);
    if (!samePlan(expected.members, members)) fail('changed');
    if (writers.length > 0) {
      const previewResidents = new Set(writers.map(({ session }) => session.id));
      await withDirectoryLocks({ root, staging, members, previewResidents }, ({ fingerprint }) => {
        if (expected.files !== fingerprint) fail('changed');
        request.signal.throwIfAborted();
        return releaseIdleWebWriters(ctx, writers);
      });
    }
    const localEntries = entries.filter((entry) => entry[recordJournal] === journal);
    let prepared;
    let committedEntry;
    let committing = false;
    let committed = false;
    try {
      await withDirectoryLocks({ root, staging, members }, async (lease) => {
        if (expected.files !== lease.fingerprint) fail('changed');
        await lease.remove({
          async prepare(plan) {
            if (!samePlan(members, (await describe(id, entries)).members)) fail('changed');
            request.signal.throwIfAborted();
            const workspaces = captureWorkspacePlacements(members.map((member) => member.id));
            const entry = {
              version: 3, phase: 'prepared', pluginVersion: manifest.version, ...plan,
              ...(workspaces ? { workspaces } : {}),
              [recordJournal]: journal,
            };
            await writeEntries(journal, [...localEntries, entry]);
            prepared = entry;
          },
          async commit() {
            request.signal.throwIfAborted();
            committing = true;
            const { workspaces: _workspaces, ...committedData } = prepared;
            const entry = { ...committedData, phase: 'committed', [recordJournal]: journal };
            await writeEntries(journal, [...localEntries, entry]);
            committedEntry = entry;
            committed = true;
          },
        });
        await finish(members, [...entries, committedEntry]);
        await writeEntries(journal, localEntries);
      });
    } catch (error) {
      if (!prepared) throw error;
      if (committed) {
        ctx.logger.warn('Session delete committed cleanup: %s', error);
        onPending?.();
        return { deleted: true, cleanupPending: true };
      }
      if (committing) {
        // Do not guess which marker persisted if publication or its fsync failed.
        ctx.logger.warn('Session delete commit: %s', error);
        onPending?.();
        fail('recovery-pending');
      }
      try {
        await recoverEntry(prepared, [...entries, prepared]);
      } catch (recoveryError) {
        onPending?.();
        throw recoveryError;
      }
      fail('restored');
    }
    return { deleted: true };
  }

  async function discoverVersionedJournals() {
    if (!legacyVersionsRoot) return [];
    let rootInfo;
    try { rootInfo = await lstat(legacyVersionsRoot); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (!rootInfo.isDirectory()) fail('unsafe-path');
    const currentVersionDir = dirname(journal);
    const found = [];
    for (const entry of await readdir(legacyVersionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^v\d/u.test(entry.name)) continue;
      const dir = join(legacyVersionsRoot, entry.name);
      if (dir === currentVersionDir) continue;
      const candidate = join(dir, 'delete-intent.json');
      if (candidate === journal || configuredLegacyJournals.includes(candidate)) continue;
      if (await hasJournalState(candidate)) found.push(candidate);
    }
    return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async function shouldLockConfiguredLegacy(candidate) {
    if (isAncestorDir(dirname(candidate), journal)) return hasJournalState(candidate);
    return pathExists(dirname(candidate));
  }

  async function withJournal(run, { createCurrent = true } = {}) {
    // Preserve every older lock and staging layout while completing legacy intents in place.
    const configured = [];
    for (const candidate of configuredLegacyJournals) {
      if (await shouldLockConfiguredLegacy(candidate)) configured.push(candidate);
    }
    const versioned = await discoverVersionedJournals();
    const includeCurrent = createCurrent || await hasJournalState(journal) || await pathExists(dirname(journal));
    const versionedLocks = includeCurrent
      ? [...new Set([journal, ...versioned])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : versioned;
    const lockOrder = [...configured, ...versionedLocks];
    const readOrder = [...configured, ...versioned, ...(includeCurrent ? [journal] : [])];

    const acquire = async (index) => {
      if (index >= lockOrder.length) {
        const entries = [];
        for (const path of readOrder) entries.push(...await readEntries(path));
        return run(entries);
      }
      const target = lockOrder[index];
      if (target === journal && createCurrent) await directoryTree(dirname(journal), true);
      return withFileLock(`${target}.lock`, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async function hasAnyJournal() {
    if (await journalExists(journal)) return true;
    for (const candidate of [...configuredLegacyJournals, ...await discoverVersionedJournals()]) {
      if (await journalExists(candidate)) return true;
    }
    return false;
  }

  const handle = (request) => {
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
        const value = await withJournal(async (entries) => {
          // The exact fetch route already enforces DSH's owner admission policy.
          // Only a preview for a member of a previously confirmed group may resume its recovery.
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
  handle.recoverPending = (signal) => {
    const result = chain.then(async () => {
      if (signal?.aborted || !await hasAnyJournal()) return false;
      let pending = false;
      await withJournal(async (entries) => {
        for (const entry of entries.filter((entry) => entry.version === 3 || entry[recordJournal] !== journal)) {
          if (signal?.aborted) {
            pending = true;
            break;
          }
          try { entries = await recoverEntry(entry, entries); }
          catch { pending = true; /* The failure is recorded and isolated to this group. */ }
        }
      }, { createCurrent: false });
      return pending;
    });
    chain = result.then(() => {}, () => {});
    return result;
  };
  return handle;
}
