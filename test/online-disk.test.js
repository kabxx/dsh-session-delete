import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { captureSessionMember, runDiskOperation } from '../src/disk-trash.js';
import { runOnlineDiskOperation, withFileLock } from '../src/online-disk.js';

const run = promisify(execFile);
const testLinux = (name, fn) => test(name, { skip: process.platform !== 'linux' }, fn);
const missing = (path) => assert.rejects(access(path), { code: 'ENOENT' });
const lockName = 'session.lock';
const current = 'session.v4.jsonl.zstd';
const old = 'session.v3.jsonl.zstd';

async function fixture(t) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'dsh-online-trash-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'sessions');
  const trashRoot = join(home, 'session-delete', 'files');
  const project = join(root, '--test--');
  const dirs = {};
  for (const id of ['main', 'child', 'other']) {
    const dir = join(project, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, lockName), '');
    await writeFile(join(dir, current), id);
    dirs[id] = dir;
  }
  await writeFile(join(dirs.main, old), 'older main history');
  const members = await Promise.all(['main', 'child'].map((id) =>
    captureSessionMember(root, id, { kind: 'jsonl', path: join(dirs[id], current) })));
  const entry = { id: 'main', ticket: randomUUID(), phase: 'pending', layout: 'online', members };
  let record = structuredClone(entry);
  const save = async (snapshot) => { record = structuredClone(snapshot); };
  const disk = { root, trashRoot, save };
  return { dirs, disk, entry, ticketDir: join(trashRoot, entry.ticket), record: () => structuredClone(record) };
}

async function stockLock(path) {
  return run('/usr/bin/flock', ['-xn', '-E', '73', path, '/usr/bin/true'], { timeout: 2500 });
}

function interruptSave(disk, after) {
  let count = 0;
  return { ...disk, save: async (entry) => {
    if (++count === after) throw new Error('injected interruption');
    await disk.save(entry);
  } };
}

testLinux('keeps native lock inodes stable and round-trips every rollout generation', async (t) => {
  const { dirs, disk, entry, ticketDir, record } = await fixture(t);
  const original = await lstat(join(dirs.main, lockName), { bigint: true });
  const expectedBytes = Buffer.byteLength('mainchildolder main history');
  let preflights = 0;
  disk.preflight = async () => {
    ++preflights;
    for (const id of ['main', 'child']) await assert.rejects(stockLock(join(dirs[id], lockName)), { code: 73 });
  };
  await runOnlineDiskOperation(entry, disk, 'move');
  assert.equal(record().phase, 'ready');
  assert.equal(record().bytes, expectedBytes);
  assert.deepEqual(await readdir(dirs.main), [lockName]);
  assert.deepEqual(await readdir(dirs.child), [lockName]);
  assert.equal((await lstat(join(dirs.main, lockName), { bigint: true })).ino, original.ino);
  assert.equal(await readFile(join(ticketDir, 'main', old), 'utf8'), 'older main history');
  assert.equal(await readFile(join(ticketDir, 'child', current), 'utf8'), 'child');
  await stockLock(join(dirs.main, lockName));
  await runOnlineDiskOperation(record(), disk, 'restore');
  assert.equal(record().phase, 'restored');
  assert.equal(await readFile(join(dirs.main, old), 'utf8'), 'older main history');
  assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
  assert.equal(await readFile(join(dirs.other, current), 'utf8'), 'other');
  assert.equal((await lstat(join(dirs.main, lockName), { bigint: true })).ino, original.ino);
  await missing(ticketDir);
  assert.equal(preflights, 2);
});

testLinux('refuses the entire group when a child writer owns the native lease', async (t) => {
  const { dirs, disk, entry, ticketDir, record } = await fixture(t);
  await withFileLock(join(dirs.child, lockName), async () => {
    await assert.rejects(runOnlineDiskOperation(entry, disk, 'move'), { code: 'locked' });
    assert.equal(record().phase, 'pending');
    assert.equal(await readFile(join(dirs.main, current), 'utf8'), 'main');
    assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
    await missing(ticketDir);
    await stockLock(join(dirs.main, lockName));
  });
  await runOnlineDiskOperation(entry, disk, 'move');
  assert.equal(record().phase, 'ready');
});

test('the actual DSH native flock blocks plugin acquisition and detects the plugin holder', {
  skip: process.platform !== 'linux' || !process.env.DSH_TEST_NATIVE_FLOCK_MODULE,
}, async (t) => {
  const { tryLockExclusive } = await import(pathToFileURL(process.env.DSH_TEST_NATIVE_FLOCK_MODULE).href);
  const { dirs, disk, entry, record } = await fixture(t);
  const path = join(dirs.child, lockName);
  const acquiredByDsh = await open(path, 'w');
  try {
    await tryLockExclusive(acquiredByDsh.fd);
    await assert.rejects(runOnlineDiskOperation(entry, disk, 'move'), { code: 'locked' });
  } finally {
    await acquiredByDsh.close();
  }
  assert.equal(record().phase, 'pending');
  await runOnlineDiskOperation(entry, {
    ...disk,
    preflight: async () => {
      const attempt = await open(path, 'w');
      try { await assert.rejects(tryLockExclusive(attempt.fd), { code: 'EAGAIN' }); }
      finally { await attempt.close(); }
    },
  }, 'move');
  assert.equal(record().phase, 'ready');
  const acquiredAgain = await open(path, 'w');
  try { await tryLockExclusive(acquiredAgain.fd); }
  finally { await acquiredAgain.close(); }
});

testLinux('resumes moving and restoring after a member mutation precedes the progress save', async (t) => {
  const { dirs, disk, entry, ticketDir, record } = await fixture(t);
  await assert.rejects(runOnlineDiskOperation(entry, interruptSave(disk, 2), 'move'), /injected interruption/);
  assert.equal(record().phase, 'moving');
  await missing(join(dirs.main, current));
  assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
  await runOnlineDiskOperation(record(), disk, 'move');
  assert.equal(record().phase, 'ready');
  await assert.rejects(runOnlineDiskOperation(record(), interruptSave(disk, 2), 'restore'), /injected interruption/);
  assert.equal(record().phase, 'restoring');
  assert.equal(await readFile(join(dirs.main, old), 'utf8'), 'older main history');
  await missing(join(dirs.child, current));
  await runOnlineDiskOperation(record(), disk, 'restore');
  assert.equal(record().phase, 'restored');
  await missing(ticketDir);
});

testLinux('permanently removes only confirmed payload and recovers after a partial purge', async (t) => {
  const { dirs, disk, entry, ticketDir, record } = await fixture(t);
  await runOnlineDiskOperation(entry, disk, 'move');
  await assert.rejects(runOnlineDiskOperation(record(), interruptSave(disk, 2), 'purge'), /injected interruption/);
  assert.equal(record().phase, 'purging');
  await missing(join(ticketDir, 'main', current));
  assert.equal(await readFile(join(ticketDir, 'child', current), 'utf8'), 'child');
  await runOnlineDiskOperation(record(), disk, 'purge');
  assert.equal(record().phase, 'purged');
  await missing(ticketDir);
  assert.deepEqual(await readdir(dirs.main), [lockName]);
  assert.deepEqual(await readdir(dirs.child), [lockName]);
  assert.equal(await readFile(join(dirs.other, current), 'utf8'), 'other');
});

testLinux('rejects recreation, unknown files, unsafe lease paths and unrelated directory identities', async (t) => {
  const { dirs, disk, entry, ticketDir, record } = await fixture(t);
  const arbitrary = join(dirs.child, 'readme.txt');
  await writeFile(arbitrary, 'unrelated');
  await assert.rejects(runOnlineDiskOperation(entry, disk, 'move'), { code: 'unsupported' });
  assert.equal(await readFile(join(dirs.main, current), 'utf8'), 'main');
  await rm(arbitrary);
  const lock = join(dirs.child, lockName);
  await rename(lock, `${lock}.saved`);
  await symlink(join(dirs.other, lockName), lock);
  await assert.rejects(runOnlineDiskOperation(entry, disk, 'move'), { code: 'unsafe-path' });
  await rm(lock);
  await rename(`${lock}.saved`, lock);
  await runOnlineDiskOperation(entry, disk, 'move');
  await writeFile(join(dirs.child, current), 'recreated session');
  for (const action of ['restore', 'purge']) {
    await assert.rejects(runOnlineDiskOperation(record(), disk, action), { code: 'collision' });
  }
  assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'recreated session');
  assert.equal(await readFile(join(ticketDir, 'child', current), 'utf8'), 'child');
  await rm(join(dirs.child, current));
  assert.equal(record().phase, 'ready');
});

testLinux('restores old full-directory trash with a fresh native lease and recovers mid-restore', async (t) => {
  const { dirs, disk, entry, ticketDir, record } = await fixture(t);
  delete entry.layout;
  await runDiskOperation(entry, disk, 'move');
  await missing(dirs.main);
  await missing(dirs.child);
  const oldLeasePath = join(ticketDir, 'main', lockName);
  const oldLease = await lstat(oldLeasePath, { bigint: true });
  const nativePath = join(dirs.main, lockName);
  // The engine preflights on an empty, locked native path before moving bytes.
  let nativeLease;
  const opts = interruptSave({ ...disk, preflight: async ({ entry: preflightEntry }) => {
    assert.equal(preflightEntry.phase, 'ready');
    assert.deepEqual(await readdir(dirs.main), [lockName]);
    await assert.rejects(stockLock(nativePath), { code: 73 });
    nativeLease = await lstat(nativePath, { bigint: true });
    assert.notEqual(nativeLease.ino, oldLease.ino);
  } }, 2);
  await assert.rejects(runOnlineDiskOperation(record(), opts, 'restore'), /injected interruption/);
  assert.equal(record().phase, 'restoring');
  assert.equal(record().layout, 'online');
  await runOnlineDiskOperation(record(), disk, 'restore');
  assert.equal(record().phase, 'restored');
  assert.equal((await lstat(nativePath, { bigint: true })).ino, nativeLease.ino);
  assert.equal(await readFile(join(dirs.main, old), 'utf8'), 'older main history');
  assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
  await missing(ticketDir);
});
