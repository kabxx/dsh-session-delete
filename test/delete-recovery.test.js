import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionDelete } from '../src/delete.js';
import { captureDirectory, withDirectoryLocks } from '../src/delete-tree.js';

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
  const residents = new Map();
  const activations = new Map();
  const owner = { _disposables: [] };
  const loop = { _disposables: [] };
  const controllerContext = { fiber: owner };
  const controller = { ctx: controllerContext, agents: { ctx: controllerContext, claims: new Map(), resumes: new Map() } };
  const ctx = {
    workspaceRegistry: { list: () => [], unpinSession() {}, unarchiveSession() {} },
    sessions: { list: () => [...residents.values()].map(({ session }) => session), get: (id) => residents.get(id)?.session },
    sessionPersistence: { stat, async list() {
      return (await Promise.all(headers.map(async (header) => (await stat(header.id)) && { header }))).filter(Boolean);
    } },
    waterfall: async () => [],
    emit() {},
    logger: { warn() {} },
    get(name) {
      if (name === 'agents') return residents;
      if (name === 'subagents') return { manager: { resident: activations } };
      if (name === 'sessionController') return controller;
      if (name !== 'storageDomain') return undefined;
      return { get: () => ({ table: () => ({ async delete(id) {
        attempts.push(id);
        if (failing.has(id)) throw Object.assign(new Error('injected cache failure'), { code: 'EIO' });
      } }) }) };
    },
  };
  const start = () => {
    const handle = createSessionDelete(ctx, options);
    return async (action, id, ticket) => {
      const response = await handle(new Request('http://localhost/api/session-delete/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, id, ticket }),
      }));
      return [response.status, await response.json()];
    };
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
  return { root, base, journal, locations, stat, failing, attempts, residents, activations, start, readJournal, webResident };
}

async function confirm(request, id, count = 0) {
  const [status, preview] = await request('preview', id);
  assert.equal(status, 200);
  assert.equal(preview.count, count);
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
  assert.deepEqual(await f.readJournal(), { version: 3, entries: [oldEntry] });
  assert.deepEqual(f.attempts, ['b']);

  assert.deepEqual(await request('preview', id), [409, { error: 'missing' }]);
  assert.equal(await f.stat(id), undefined);
  assert.ok(await f.stat('a'));
  assert.deepEqual(await f.readJournal(), { version: 3, entries: [] });
  assert.deepEqual(f.attempts, ['b', id]);
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
