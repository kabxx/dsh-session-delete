import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRecoveryLoop, createSessionDelete } from '../src/delete.js';
import { captureDirectory, withDirectoryLocks } from '../src/delete-tree.js';
import { acquirePathLock } from '../src/platform-fs.js';
import manifest from '../package.json' with { type: 'json' };

const platformTest = (name, body) => test(name, { skip: process.platform !== 'linux' && !process.env.DSH_INSTALL_DIR }, body);

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'dsh-delete-recovery-'));
  t.after(() => rm(base, { recursive: true }));
  const root = join(base, 'sessions');
  const journal = join(base, 'delete-intent.json');
  const options = { root, journal, legacyTrash: join(base, 'trash.json') };
  const locations = new Map();
  const headers = [
    { id: 'a' }, { id: 'a-child', origin: 'subagent', parentSession: 'a' },
    { id: 'b' }, { id: 'c' },
  ];
  for (const { id } of headers) {
    const dir = join(root, '--project--', id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'session.v4.jsonl');
    await writeFile(path, id);
    await writeFile(join(dir, 'session.lock'), '');
    locations.set(id, { kind: 'jsonl', path });
  }
  async function stat(id) {
    const location = locations.get(id);
    if (!location) return undefined;
    try { await lstat(location.path); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    return { location };
  }
  const failing = new Set();
  const attempts = [];
  const removedEvents = [];
  const unpinned = [];
  const unarchived = [];
  const workspaces = [];
  const workspaceRecords = new Map();
  let useWorkspaceTable = false;
  const residents = new Map();
  const activations = new Map();
  const owner = { _disposables: [] };
  const loop = { _disposables: [] };
  const controllerContext = { fiber: owner };
  const controller = { ctx: controllerContext, agents: { ctx: controllerContext, claims: new Map(), resumes: new Map() } };
  const ctx = {
    workspaceRegistry: {
      list: () => workspaces,
      get: (id) => workspaces.find((workspace) => workspace.id === id),
      unpinSession(id) { unpinned.push(id); },
      unarchiveSession(id) { unarchived.push(id); },
    },
    sessions: { list: () => [...residents.values()].map(({ session }) => session), get: (id) => residents.get(id)?.session },
    sessionPersistence: { stat, async list() {
      return (await Promise.all(headers.map(async (header) => (await stat(header.id)) && { header }))).filter(Boolean);
    } },
    waterfall: async () => [],
    emit(event, id) {
      if (event === 'api-session/removed') removedEvents.push(id);
    },
    logger: { warn() {} },
    get(name) {
      if (name === 'agents') return residents;
      if (name === 'subagents') return { manager: { resident: activations } };
      if (name === 'sessionController') return controller;
      if (name !== 'storageDomain') return undefined;
      return {
        get: (domainName) => {
          if (domainName === 'workspace') {
            if (!useWorkspaceTable) return undefined;
            return { table: () => ({ get: (id) => workspaceRecords.get(id) }) };
          }
          return { table: () => ({ async delete(id) {
            attempts.push(id);
            if (failing.has(id)) throw Object.assign(new Error('injected cache failure'), { code: 'EIO' });
          } }) };
        },
      };
    },
  };
  const start = (overrides) => {
    const handle = createSessionDelete(ctx, { ...options, ...overrides });
    return Object.assign(async (action, id, ticket, extraHeaders) => {
      const response = await handle(new Request('http://localhost/api/session-delete/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({ action, id, ticket }),
      }));
      return [response.status, await response.json()];
    }, { recover: handle.recoverPending });
  };
  const readJournal = async () => JSON.parse(await readFile(journal, 'utf8'));
  function webResident(id) {
    const effect = Symbol.for('cordis.effect');
    const label = `agentLoop.lifecycle(${id})`;
    const addCallback = () => {
      const callback = () => assert.fail('An ambiguous owner must not be released');
      callback[effect] = { label, children: [] };
      owner._disposables.push(callback);
    };
    addCallback();
    const rawDispose = () => {};
    rawDispose[effect] = { label: 'scope', children: [] };
    const dispose = () => assert.fail('The underlying scope must not be disposed directly');
    dispose[effect] = { label: `agentLoop.scope(${id})`, children: [rawDispose[effect]] };
    loop._disposables.push(dispose);
    const agent = {
      session: { id, header: { id } }, status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: false },
      scope: { rawDispose }, loopCtx: { fiber: loop }, lifetimeSignal: new AbortController().signal,
    };
    residents.set(id, agent);
    return { agent, addCallback };
  }
  return {
    root, base, journal, locations, headers, stat, failing, attempts, removedEvents, unpinned, unarchived,
    workspaces, workspaceRecords, enableWorkspaceTable: () => { useWorkspaceTable = true; },
    residents, activations, start, readJournal, webResident,
  };
}

async function confirm(request, id, count = 0) {
  const [status, preview] = await request('preview', id);
  assert.equal(status, 200);
  assert.equal(preview.count, count);
  assert.ok(preview.memberIds.includes(id));
  assert.equal(new Set(preview.memberIds).size, count + 1);
  return request('delete', id, preview.ticket);
}

platformTest('failed record cleanup persists per group without blocking or retrying unrelated deletes', async (t) => {
  const f = await fixture(t);
  const request = f.start();
  f.failing.add('a-child');
  assert.deepEqual(await confirm(request, 'a', 1), [200, { deleted: true, cleanupPending: true }]);
  assert.equal(await f.stat('a'), undefined);
  assert.equal(await f.stat('a-child'), undefined);
  const { entries: [a] } = await f.readJournal();
  assert.deepEqual(f.attempts, ['a', 'a-child']);

  const afterRestart = f.start();
  assert.deepEqual(await confirm(afterRestart, 'b'), [200, { deleted: true }]);
  assert.equal(await f.stat('b'), undefined);
  assert.deepEqual(f.attempts, ['a', 'a-child', 'b']);
  assert.deepEqual((await f.readJournal()).entries, [a]);

  f.failing.add('c');
  assert.deepEqual(await confirm(afterRestart, 'c'), [200, { deleted: true, cleanupPending: true }]);
  const { entries: [retained, c] } = await f.readJournal();
  assert.deepEqual(retained, a);
  assert.deepEqual(f.attempts, ['a', 'a-child', 'b', 'c']);
  assert.deepEqual(await afterRestart('preview', 'a-child'), [409, { error: 'cleanup-pending' }]);
  f.failing.delete('a-child');
  assert.deepEqual(await afterRestart('preview', 'a'), [409, { error: 'missing' }]);
  assert.deepEqual((await f.readJournal()).entries, [c]);
  assert.deepEqual(f.attempts, ['a', 'a-child', 'b', 'c', 'a', 'a-child', 'a', 'a-child']);
});

platformTest('keeps an older committed child deletion scoped during unrelated requests', async (t) => {
  const f = await fixture(t);
  const id = 'a-child';
  const members = [await captureDirectory(f.root, id, f.locations.get(id))];
  const interrupted = new Error('interrupted just after writing the old journal');
  let oldEntry;
  await assert.rejects(withDirectoryLocks({
    root: f.root, staging: join(f.base, 'directory-deletion'), members,
  }, ({ remove }) => remove(async (plan) => {
    oldEntry = { version: 2, ...plan };
    await writeFile(f.journal, JSON.stringify(oldEntry));
    throw interrupted;
  })), interrupted);

  const request = f.start();
  assert.deepEqual(await request('preview', 'a'), [409, { error: 'cleanup-pending' }]);
  assert.deepEqual(await confirm(request, 'b'), [200, { deleted: true }]);
  assert.ok(await f.stat(id));
  assert.deepEqual(await f.readJournal(), { version: 4, entries: [oldEntry] });
  assert.deepEqual(f.attempts, ['b']);

  assert.deepEqual(await request('preview', id), [409, { error: 'missing' }]);
  assert.equal(await f.stat(id), undefined);
  assert.ok(await f.stat('a'));
  assert.deepEqual(await f.readJournal(), { version: 4, entries: [] });
  assert.deepEqual(f.attempts, ['b', id]);
});

async function recordInterruptedGroup(f, phase) {
  const ids = ['a', 'a-child'];
  const members = await Promise.all(ids.map((id) => captureDirectory(f.root, id, f.locations.get(id))));
  const staging = join(f.base, 'directory-deletion');
  let transaction;
  await assert.rejects(withDirectoryLocks({ root: f.root, staging, members }, (lease) => lease.remove({
    async prepare(plan) {
      transaction = join(staging, plan.transaction);
      const entry = { version: 3, phase, ...plan };
      if (phase === 'prepared') {
        await writeFile(f.journal, JSON.stringify({ version: 4, entries: [entry] }));
      } else {
        lease.entry = entry;
      }
    },
    async commit() {
      if (lease.entry) await writeFile(f.journal, JSON.stringify({ version: 4, entries: [lease.entry] }));
      throw new Error('simulated interruption before cleanup');
    },
  })), /simulated interruption/u);
  return transaction;
}

platformTest('new deletes use the package journal while legacy staged data is recovered in place', async (t) => {
  const f = await fixture(t);
  const pending = await recordInterruptedGroup(f, 'committed');
  const journal = join(f.base, 'plugins', '@kabxx', 'dsh-session-delete', 'delete-intent.json');
  const newOptions = { journal, legacyJournal: f.journal };
  const [status, value] = await confirm(f.start(newOptions), 'b');
  assert.equal(status, 200);
  assert.deepEqual(value, { deleted: true });
  assert.deepEqual(f.attempts, ['b']);
  assert.ok((await f.readJournal()).entries.length);
  assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')).entries, []);
  assert.equal(await readFile(join(pending, '0', 'session.v4.jsonl'), 'utf8'), 'a');

  await f.start(newOptions).recover();
  assert.deepEqual(f.attempts, ['b', 'a', 'a-child']);
  assert.deepEqual((await f.readJournal()).entries, []);
  await assert.rejects(lstat(pending), { code: 'ENOENT' });
});

platformTest('a fresh install does not create the legacy directory', async (t) => {
  const f = await fixture(t);
  const journal = join(f.base, 'plugins', '@kabxx', 'dsh-session-delete', 'delete-intent.json');
  const legacy = join(f.base, 'previous', 'delete-intent.json');
  f.failing.add('b');
  assert.deepEqual(await confirm(f.start({ journal, legacyJournal: legacy }), 'b'),
    [200, { deleted: true, cleanupPending: true }]);
  await assert.rejects(lstat(join(legacy, '..')), { code: 'ENOENT' });
  const { entries: [entry] } = JSON.parse(await readFile(journal, 'utf8'));
  assert.equal(entry.pluginVersion, manifest.version);
  assert.equal(entry.phase, 'committed');
});

platformTest('rollback defers recovery while an already detached replacement still has a writer', async (t) => {
  const f = await fixture(t);
  const transaction = await recordInterruptedGroup(f, 'prepared');
  const child = f.locations.get('a-child').path;
  const replacement = join(child, '..');
  const detachedReplacement = join(transaction, '1.replacement');
  await mkdir(replacement);
  await writeFile(child, 'replacement rollout');
  await writeFile(join(replacement, 'session.lock'), '');
  const writer = await acquirePathLock(join(replacement, 'session.lock'));
  try {
    // A previous version could move the replacement without taking its lock.
    await rename(replacement, detachedReplacement);
    await f.start().recover();
    assert.equal((await f.readJournal()).entries[0].phase, 'prepared');
    assert.equal(await readFile(join(detachedReplacement, 'session.v4.jsonl'), 'utf8'), 'replacement rollout');
    assert.equal(await readFile(join(transaction, '1', 'session.v4.jsonl'), 'utf8'), 'a-child');
    await assert.rejects(lstat(replacement), { code: 'ENOENT' });
  } finally {
    await writer.handle.close();
  }
  await f.start().recover();
  assert.equal(await readFile(child, 'utf8'), 'a-child');
  assert.deepEqual((await f.readJournal()).entries, []);
});

platformTest('startup rolls back a partly staged group and preserves every rollout', async (t) => {
  const f = await fixture(t);
  const transaction = await recordInterruptedGroup(f, 'prepared');
  const child = f.locations.get('a-child').path;
  await rename(join(transaction, '1'), join(child, '..'));
  assert.equal(await f.stat('a'), undefined);
  await f.start().recover();
  assert.equal(await readFile(f.locations.get('a').path, 'utf8'), 'a');
  assert.equal(await readFile(child, 'utf8'), 'a-child');
  assert.deepEqual((await f.readJournal()).entries, []);
  assert.deepEqual(f.attempts, []);
});

platformTest('startup retries a committed group without restoring staged files', async (t) => {
  const f = await fixture(t);
  const transaction = await recordInterruptedGroup(f, 'committed');
  await rm(join(transaction, '0'), { recursive: true });
  await f.start().recover();
  assert.equal(await f.stat('a'), undefined);
  assert.equal(await f.stat('a-child'), undefined);
  assert.deepEqual((await f.readJournal()).entries, []);
  assert.deepEqual(f.attempts, ['a', 'a-child']);
});

platformTest('rollback waits for a replacement directory writer before removing it', async (t) => {
  const f = await fixture(t);
  const transaction = await recordInterruptedGroup(f, 'prepared');
  const child = f.locations.get('a-child').path;
  const replacement = join(child, '..');
  await mkdir(replacement);
  await writeFile(child, 'replacement rollout');
  await writeFile(join(replacement, 'session.lock'), '');
  const writer = await acquirePathLock(join(replacement, 'session.lock'));
  try {
    await f.start().recover();
    assert.equal((await f.readJournal()).entries[0].phase, 'prepared');
    assert.equal(await readFile(child, 'utf8'), 'replacement rollout');
    await appendFile(child, '\nnew message');
    assert.equal(await readFile(child, 'utf8'), 'replacement rollout\nnew message');
    assert.equal(await readFile(join(transaction, '1', 'session.v4.jsonl'), 'utf8'), 'a-child');
  } finally {
    await writer.handle.close();
  }
  await f.start().recover();
  assert.equal(await readFile(child, 'utf8'), 'a-child');
  assert.deepEqual((await f.readJournal()).entries, []);
});

platformTest('rollback replaces a nonempty directory at the original path and keeps its link target', async (t) => {
  const f = await fixture(t);
  const transaction = await recordInterruptedGroup(f, 'prepared');
  const child = f.locations.get('a-child').path;
  const replacement = join(child, '..');
  const extra = join(replacement, 'nested', 'extra.txt');
  const control = f.locations.get('b').path;
  await mkdir(join(extra, '..'), { recursive: true });
  await writeFile(child, 'replacement rollout');
  await writeFile(extra, 'replacement data');
  await symlink(join(control, '..'), join(replacement, 'linked-session'), 'junction');

  await f.start().recover();
  assert.equal(await readFile(f.locations.get('a').path, 'utf8'), 'a');
  assert.equal(await readFile(child, 'utf8'), 'a-child');
  assert.equal(await readFile(control, 'utf8'), 'b');
  await assert.rejects(lstat(extra), { code: 'ENOENT' });
  await assert.rejects(lstat(transaction), { code: 'ENOENT' });
  assert.deepEqual((await f.readJournal()).entries, []);
  assert.deepEqual(f.attempts, []);
});

platformTest('rollback resumes after moving a replacement out of the original path', async (t) => {
  const f = await fixture(t);
  const transaction = await recordInterruptedGroup(f, 'prepared');
  const child = f.locations.get('a-child').path;
  const replacement = join(child, '..');
  await mkdir(replacement);
  await writeFile(child, 'replacement rollout');
  // Simulate stopping after the conflict was moved aside, before discarding it.
  await rename(replacement, join(transaction, '1.replacement'));

  await f.start().recover();
  assert.equal(await readFile(f.locations.get('a').path, 'utf8'), 'a');
  assert.equal(await readFile(child, 'utf8'), 'a-child');
  await assert.rejects(lstat(transaction), { code: 'ENOENT' });
  assert.deepEqual((await f.readJournal()).entries, []);
});

platformTest('rollback preserves the replacement if the staged rollout fails verification', async (t) => {
  const f = await fixture(t);
  const transaction = await recordInterruptedGroup(f, 'prepared');
  const child = f.locations.get('a-child').path;
  await mkdir(join(child, '..'));
  await writeFile(child, 'replacement rollout');
  await writeFile(join(transaction, '1', 'session.v4.jsonl'), 'changed staged rollout');

  await f.start().recover();
  assert.equal(await readFile(child, 'utf8'), 'replacement rollout');
  assert.equal((await f.readJournal()).entries[0].phase, 'prepared');
  assert.deepEqual(await confirm(f.start(), 'b'), [200, { deleted: true }]);
});

platformTest('a managed child can finish native settlement while deletion prepares', async (t) => {
  const f = await fixture(t);
  const child = 'a-child';
  const agent = {
    session: { id: child, header: { id: child, origin: 'subagent', parentSession: 'a' } },
    status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: false },
  };
  f.residents.set(child, agent);
  let observed = false;
  f.activations.set(child, {
    kind: 'local', handle: { agent },
    get accepted() {
      if (!observed) {
        observed = true;
        setImmediate(() => {
          f.residents.delete(child);
          f.activations.delete(child);
        });
      }
      return true;
    },
  });
  assert.deepEqual(await confirm(f.start(), 'a', 1), [200, { deleted: true }]);
  assert.ok(observed);
  assert.equal(await f.stat(child), undefined);
});

platformTest('a managed child with queued input still blocks the whole group', async (t) => {
  const f = await fixture(t);
  const child = 'a-child';
  const agent = {
    session: { id: child, header: { id: child, origin: 'subagent', parentSession: 'a' } },
    status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: true },
  };
  f.residents.set(child, agent);
  f.activations.set(child, { kind: 'local', accepted: true, handle: { agent } });
  assert.deepEqual(await f.start()('preview', 'a'), [409, { error: 'busy' }]);
  assert.ok(await f.stat(child));
  assert.ok(await f.stat('a'));
});

platformTest('duplicate Web owner callbacks block preview and leave the resident untouched', async (t) => {
  const f = await fixture(t);
  const { agent, addCallback } = f.webResident('b');
  addCallback();
  assert.deepEqual(await f.start()('preview', 'b'), [409, { error: 'locked' }]);
  assert.equal(f.residents.get('b'), agent);
  assert.ok(await f.stat('b'));
  assert.deepEqual(f.attempts, []);
});

platformTest('a duplicate Web owner callback added after preview blocks confirmed deletion', async (t) => {
  const f = await fixture(t);
  const { agent, addCallback } = f.webResident('b');
  const request = f.start();
  const [status, preview] = await request('preview', 'b');
  assert.equal(status, 200);
  addCallback();
  assert.deepEqual(await request('delete', 'b', preview.ticket), [409, { error: 'locked' }]);
  assert.equal(f.residents.get('b'), agent);
  assert.ok(await f.stat('b'));
  assert.deepEqual(f.attempts, []);
});

platformTest('committed cleanup retires cleanly when one member ID is recreated without touching the new session', async (t) => {
  const f = await fixture(t);
  const request = f.start();
  f.failing.add('a-child');
  assert.deepEqual(await confirm(request, 'a', 1), [200, { deleted: true, cleanupPending: true }]);
  assert.equal(await f.stat('a'), undefined);
  assert.equal(await f.stat('a-child'), undefined);

  // Recreate a brand-new session with the exact same ID 'a' while old cleanup is still pending.
  const recreatedDir = join(f.root, '--project--', 'a');
  const recreatedPath = join(recreatedDir, 'session.v4.jsonl');
  await mkdir(recreatedDir, { recursive: true });
  await writeFile(recreatedPath, 'recreated a');
  await writeFile(join(recreatedDir, 'session.lock'), '');

  f.failing.delete('a-child');
  f.attempts.length = 0;
  f.removedEvents.length = 0;

  const afterRestart = f.start();
  const [status, preview] = await afterRestart('preview', 'a');
  assert.equal(status, 200);
  assert.equal(preview.count, 0);
  assert.deepEqual(preview.memberIds, ['a']);
  assert.equal(await readFile(recreatedPath, 'utf8'), 'recreated a');
  assert.deepEqual(f.attempts, ['a-child']);
  assert.deepEqual(f.removedEvents, ['a-child']);
  assert.deepEqual((await f.readJournal()).entries, []);

  // The recreated session can now be deleted normally.
  assert.deepEqual(await afterRestart('delete', 'a', preview.ticket), [200, { deleted: true }]);
  assert.equal(await f.stat('a'), undefined);
});

platformTest('committed recovery detaches workspace IDs even when workspace.sessionIds filters out missing logs', async (t) => {
  const f = await fixture(t);
  await recordInterruptedGroup(f, 'committed');
  const rawStored = ['a', 'a-child', 'b'];
  const detached = [];
  f.workspaces.push({
    id: 'ws-1',
    // Simulate WorkspaceEntity.sessionIds filtering out missing sessions after a crash/restart.
    get sessionIds() { return rawStored.filter((id) => id === 'b'); },
    async detachSession(id) {
      detached.push(id);
      const index = rawStored.indexOf(id);
      if (index >= 0) rawStored.splice(index, 1);
    },
  });

  const remaining = await f.start().recover();
  assert.equal(remaining, false);
  assert.deepEqual(detached, ['a', 'a-child']);
  assert.deepEqual(rawStored, ['b']);
  assert.deepEqual((await f.readJournal()).entries, []);
});

platformTest('recovery loop retries automatically after a lock clears and wakes on session disposal', async (t) => {
  const f = await fixture(t);
  await recordInterruptedGroup(f, 'prepared');
  const child = f.locations.get('a-child').path;
  const replacement = join(child, '..');
  await mkdir(replacement);
  await writeFile(child, 'replacement rollout');
  await writeFile(join(replacement, 'session.lock'), '');

  const lifetime = new AbortController();
  const writer = await acquirePathLock(join(replacement, 'session.lock'));
  let loop;
  try {
    const request = f.start();
    loop = createRecoveryLoop(request.recover, { signal: lifetime.signal, delays: [60_000], disposedDelay: 15 });
    loop.triggerNow();
    await delay(80);
    assert.equal((await f.readJournal()).entries[0].phase, 'prepared');
    await writer.handle.close();
    // Long backoff would wait 60s, so session disposal wakes recovery immediately.
    loop.notifySessionDisposed();
    for (let i = 0; i < 40 && (await f.readJournal()).entries.length > 0; i += 1) {
      await delay(25);
    }
    assert.equal(await readFile(child, 'utf8'), 'a-child');
    assert.deepEqual((await f.readJournal()).entries, []);
  } finally {
    loop?.dispose();
    lifetime.abort();
    await writer.handle.close().catch(() => {});
  }
});

platformTest('recovery loop retries automatically via backoff timer after external lock or runtime cleanup failure', async (t) => {
  const f = await fixture(t);
  let pendingNotifications = 0;
  const lifetime = new AbortController();
  let loop;
  try {
    const request = f.start({ onPending: () => { pendingNotifications += 1; loop?.notifyPending(); } });
    loop = createRecoveryLoop(request.recover, { signal: lifetime.signal, delays: [20, 40] });
    f.failing.add('a-child');
    assert.deepEqual(await confirm(request, 'a', 1), [200, { deleted: true, cleanupPending: true }]);
    assert.equal(pendingNotifications, 1);
    await delay(50);
    assert.equal((await f.readJournal()).entries.length, 1);
    f.failing.delete('a-child');
    for (let i = 0; i < 40 && (await f.readJournal()).entries.length > 0; i += 1) {
      await delay(25);
    }
    assert.deepEqual((await f.readJournal()).entries, []);
  } finally {
    loop?.dispose();
    lifetime.abort();
  }
});

platformTest('preview returns the full member set even when a child ID sorts before its parent', async (t) => {
  const f = await fixture(t);
  const parentDir = join(f.root, '--project--', 'z-parent');
  const childDir = join(f.root, '--project--', '0-child');
  for (const [id, dir] of [['z-parent', parentDir], ['0-child', childDir]]) {
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'session.v4.jsonl');
    await writeFile(path, id);
    await writeFile(join(dir, 'session.lock'), '');
    f.locations.set(id, { kind: 'jsonl', path });
  }
  f.headers.push({ id: 'z-parent' }, { id: '0-child', origin: 'subagent', parentSession: 'z-parent' });

  const [status, preview] = await f.start()('preview', 'z-parent');
  assert.equal(status, 200);
  assert.equal(preview.count, 1);
  assert.deepEqual(new Set(preview.memberIds), new Set(['z-parent', '0-child']));
});

function addMockWorkspace(f, id, initialSessionIds, indexed) {
  f.enableWorkspaceTable();
  const record = { id, sessionIds: [...initialSessionIds] };
  f.workspaceRecords.set(id, record);
  let detachCalls = 0;
  const mutate = (fn) => {
    const next = fn([...record.sessionIds]);
    // Mirror WorkspaceEntity.mutate: prune any session absent from the startup/live header index.
    record.sessionIds = next.filter((sessionId) => indexed.has(sessionId));
  };
  const entity = {
    id,
    get detachCalls() { return detachCalls; },
    get rawSessionIds() { return [...record.sessionIds]; },
    get sessionIds() { return record.sessionIds.filter((sessionId) => indexed.has(sessionId)); },
    async status() { return 'ok'; },
    async detachSession(sessionId) {
      detachCalls += 1;
      mutate((ids) => ids.filter((item) => item !== sessionId));
    },
    async attachSession(sessionId) {
      if (!record.sessionIds.includes(sessionId)) {
        if (!await f.stat(sessionId)) throw new Error(`missing session ${sessionId}`);
        indexed.add(sessionId);
      }
      mutate((ids) => (ids.includes(sessionId) ? ids : [sessionId, ...ids]));
    },
    async insertSessionBefore(sessionId, beforeSessionId) {
      mutate((ids) => {
        if (!ids.includes(sessionId)) throw new Error(`unaccounted ${sessionId}`);
        if (beforeSessionId !== undefined && !ids.includes(beforeSessionId)) throw new Error(`unaccounted ${beforeSessionId}`);
        const without = ids.filter((item) => item !== sessionId);
        const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId);
        return [...without.slice(0, at), sessionId, ...without.slice(at)];
      });
    },
  };
  f.workspaces.push(entity);
  return entity;
}

platformTest('deleting B while A is pending rollback preserves A workspace membership across different and same workspaces', async (t) => {
  // Case 1: A (pending rollback after restart) is in ws-1, B is in ws-2.
  const f1 = await fixture(t);
  await recordInterruptedGroup(f1, 'prepared');
  const indexed1 = new Set(['b', 'c']);
  const ws1 = addMockWorkspace(f1, 'ws-1', ['a', 'c'], indexed1);
  const ws2 = addMockWorkspace(f1, 'ws-2', ['b'], indexed1);

  const req1 = f1.start();
  assert.deepEqual(await confirm(req1, 'b'), [200, { deleted: true }]);
  assert.equal(ws1.detachCalls, 0);
  assert.equal(ws2.detachCalls, 1);
  assert.deepEqual(ws1.rawSessionIds, ['a', 'c']);
  assert.deepEqual(ws2.rawSessionIds, []);

  assert.equal(await req1.recover(), false);
  assert.deepEqual(ws1.sessionIds, ['a', 'c']);
  assert.deepEqual(ws1.rawSessionIds, ['a', 'c']);

  // Case 2: A (pending rollback after restart) and B share ws-shared; deleting B prunes unindexed A,
  // and rolling A back re-attaches A in its original slot before C.
  const f2 = await fixture(t);
  await recordInterruptedGroup(f2, 'prepared');
  const indexed2 = new Set(['b', 'c']);
  const shared = addMockWorkspace(f2, 'ws-shared', ['a', 'b', 'c'], indexed2);

  const req2 = f2.start();
  assert.deepEqual(await confirm(req2, 'b'), [200, { deleted: true }]);
  assert.deepEqual(shared.rawSessionIds, ['c']);
  assert.equal(await req2.recover(), false);
  assert.deepEqual(shared.sessionIds, ['a', 'c']);
  assert.deepEqual(shared.rawSessionIds, ['a', 'c']);
});

platformTest('re-checks same-ID recreation between cleanup steps so recreated session keeps pin, archive, and cache', async (t) => {
  const f = await fixture(t);
  await recordInterruptedGroup(f, 'committed');
  const recreatedDir = join(f.root, '--project--', 'a');
  const recreatedPath = join(recreatedDir, 'session.v4.jsonl');
  f.workspaces.push({
    id: 'ws-1',
    sessionIds: ['a', 'a-child'],
    async detachSession(id) {
      if (id === 'a') {
        // Simulate a brand-new session with ID 'a' materializing right as workspace detach finishes.
        await mkdir(recreatedDir, { recursive: true });
        await writeFile(recreatedPath, 'recreated mid-cleanup');
        await writeFile(join(recreatedDir, 'session.lock'), '');
      }
    },
  });

  assert.equal(await f.start().recover(), false);
  assert.deepEqual(f.unpinned, ['a-child']);
  assert.deepEqual(f.unarchived, ['a-child']);
  assert.deepEqual(f.attempts, ['a-child']);
  assert.equal(await readFile(recreatedPath, 'utf8'), 'recreated mid-cleanup');
});

platformTest('deletes valid custom session IDs longer than 200 characters', async (t) => {
  const f = await fixture(t);
  const longId = `custom-${'x'.repeat(213)}`;
  const dir = join(f.root, '--project--', longId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'session.v4.jsonl');
  await writeFile(path, longId);
  await writeFile(join(dir, 'session.lock'), '');
  f.locations.set(longId, { kind: 'jsonl', path });
  f.headers.push({ id: longId });

  assert.deepEqual(await confirm(f.start(), longId), [200, { deleted: true }]);
  assert.equal(await f.stat(longId), undefined);
});

platformTest('binds preview tickets only to dsh-auth-* cookies, ignoring unrelated same-site cookies', async (t) => {
  const f = await fixture(t);
  const request = f.start();

  const [p1Status, p1] = await request('preview', 'a', undefined, { cookie: 'dsh-auth-host=v1.alpha; theme=dark; other=1' });
  assert.equal(p1Status, 200);
  // Changing unrelated cookies (or cookie order) does not invalidate the ticket.
  assert.deepEqual(
    await request('delete', 'a', p1.ticket, { cookie: 'other=2; dsh-auth-host=v1.alpha; analytics=abc' }),
    [200, { deleted: true }],
  );
  assert.equal(await f.stat('a'), undefined);

  const [p2Status, p2] = await request('preview', 'b', undefined, { cookie: 'dsh-auth-host=v1.alpha; theme=dark' });
  assert.equal(p2Status, 200);
  // Changing the DSH auth cookie itself still invalidates the ticket.
  assert.deepEqual(
    await request('delete', 'b', p2.ticket, { cookie: 'dsh-auth-host=v1.beta; theme=dark' }),
    [409, { error: 'changed' }],
  );
  assert.ok(await f.stat('b'));
});
