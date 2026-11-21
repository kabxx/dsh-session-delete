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
  const ctx = {
    workspaceRegistry: { list: () => [], unpinSession() {}, unarchiveSession() {} },
    sessions: { list: () => [] },
    sessionPersistence: { stat, async list() {
      return (await Promise.all(headers.map(async (header) => (await stat(header.id)) && { header }))).filter(Boolean);
    } },
    waterfall: async () => [],
    emit() {},
    logger: { warn() {} },
    get(name) {
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
  return { root, base, journal, locations, stat, failing, attempts, start, readJournal };
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
