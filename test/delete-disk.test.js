import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { withDeleteLocks } from '../src/delete-disk.js';
import { captureSessionMember } from '../src/disk-trash.js';
import { withFileLock } from '../src/online-disk.js';

const lockName = 'session.lock';
const current = 'session.v4.jsonl.zstd';
const older = 'session.v3.jsonl';
const linuxTest = (name, body) => test(name, { skip: process.platform !== 'linux' }, body);

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'dsh-direct-delete-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'sessions');
  const dirs = {};
  for (const id of ['parent', 'child', 'other']) {
    const dir = join(root, '--project--', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, current), id);
    await writeFile(join(dir, lockName), '');
    dirs[id] = dir;
  }
  await writeFile(join(dirs.parent, older), 'historical rollout');
  const members = await Promise.all(['parent', 'child'].map((id) =>
    captureSessionMember(root, id, { kind: 'jsonl', path: join(dirs[id], current) })));
  return { root, dirs, members };
}

linuxTest('preview shows the whole verified plan and releases locks without deleting logs', async (t) => {
  const { root, members, dirs } = await fixture(t);
  const payloads = await withDeleteLocks({ root, members }, async (lease) => {
    for (const id of ['parent', 'child']) {
      await assert.rejects(withFileLock(join(dirs[id], lockName), () => {}), { code: 'locked' });
    }
    await assert.rejects(lease.remove(), { code: 'bad-state' });
    return lease.members.map(({ payload }) => payload.map(({ name }) => name));
  });
  assert.deepEqual(payloads, [[older, current], [current]]);
  assert.equal(await readFile(join(dirs.parent, current), 'utf8'), 'parent');
  assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
  await withFileLock(join(dirs.child, lockName), () => {});
});

linuxTest('a busy native lease rejects the whole group before invoking its callback', async (t) => {
  const { root, members, dirs } = await fixture(t);
  await withFileLock(join(dirs.parent, lockName), async () => {
    await assert.rejects(withDeleteLocks({ root, members }, () => assert.fail('callback must not run')), { code: 'locked' });
    assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
    await withFileLock(join(dirs.child, lockName), () => {});
  });
});

test('the installed DSH flock binding and the direct disk operation exclude one another', {
  skip: process.platform !== 'linux' || !process.env.DSH_TEST_NATIVE_FLOCK_MODULE,
}, async (t) => {
  const { tryLockExclusive } = await import(pathToFileURL(process.env.DSH_TEST_NATIVE_FLOCK_MODULE).href);
  const { root, members, dirs } = await fixture(t);
  const path = join(dirs.parent, lockName);
  const handle = await open(path, 'w');
  try {
    await tryLockExclusive(handle.fd);
    await assert.rejects(withDeleteLocks({ root, members }, () => assert.fail('callback must not run')), { code: 'locked' });
  } finally {
    await handle.close();
  }
  await withDeleteLocks({ root, members }, async (lease) => {
    await lease.remove(async () => {
      const other = await open(path, 'w');
      try { await assert.rejects(tryLockExclusive(other.fd), { code: 'EAGAIN' }); }
      finally { await other.close(); }
    });
  });
});

linuxTest('writes the confirmed plan before deleting every rollout, retains lock inodes through cleanup', async (t) => {
  const { root, members, dirs } = await fixture(t);
  const lockPath = join(dirs.parent, lockName);
  const before = await lstat(lockPath, { bigint: true });
  let journal;
  await withDeleteLocks({ root, members }, async (lease) => {
    await lease.remove(async (plan) => {
      assert.equal(await readFile(join(dirs.parent, older), 'utf8'), 'historical rollout');
      assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
      await assert.rejects(withFileLock(lockPath, () => {}), { code: 'locked' });
      journal = JSON.parse(JSON.stringify(plan));
    });
    await assert.rejects(withFileLock(lockPath, () => {}), { code: 'locked' });
    assert.deepEqual(await readdir(dirs.parent), [lockName]);
    assert.deepEqual(await readdir(dirs.child), [lockName]);
  });
  assert.equal(journal[0].payload.length, 2);
  assert.equal((await lstat(lockPath, { bigint: true })).ino, before.ino);
  assert.equal(await readFile(join(dirs.other, current), 'utf8'), 'other');
});

linuxTest('a failed journal write leaves all group logs intact', async (t) => {
  const { root, members, dirs } = await fixture(t);
  await assert.rejects(withDeleteLocks({ root, members }, (lease) => lease.remove(() => {
    throw new Error('journal fsync failed');
  })), /journal fsync failed/u);
  assert.equal(await readFile(join(dirs.parent, current), 'utf8'), 'parent');
  assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
});

linuxTest('resumes a persisted partial deletion and accepts a previously completed deletion', async (t) => {
  const { root, members, dirs } = await fixture(t);
  let journal;
  // Retain the exact stored plan, then emulate an interruption after one unlink.
  await assert.rejects(withDeleteLocks({ root, members }, (lease) => lease.remove((plan) => {
    journal = JSON.parse(JSON.stringify(plan));
    throw new Error('interrupted after commit');
  })), /interrupted after commit/u);
  await unlink(join(dirs.parent, older));
  await withDeleteLocks({ root, members: journal, committed: true }, (lease) => lease.remove());
  await withDeleteLocks({ root, members: journal, committed: true }, (lease) => lease.remove());
  assert.deepEqual(await readdir(dirs.parent), [lockName]);
  assert.deepEqual(await readdir(dirs.child), [lockName]);
  assert.equal(await readFile(join(dirs.other, current), 'utf8'), 'other');
});

linuxTest('a replacement generation or lock inode prevents resumption before any group deletion', async (t) => {
  const { root, members, dirs } = await fixture(t);
  const journal = await withDeleteLocks({ root, members }, (lease) => lease.members);
  const childLog = join(dirs.child, current);
  await rename(childLog, `${childLog}.old`);
  await writeFile(childLog, 'child');
  await unlink(`${childLog}.old`);
  await assert.rejects(withDeleteLocks({ root, members: journal, committed: true }, (lease) => lease.remove()), { code: 'collision' });
  assert.equal(await readFile(join(dirs.parent, current), 'utf8'), 'parent');
  const fresh = await withDeleteLocks({ root, members }, (lease) => lease.members);
  const childLock = join(dirs.child, lockName);
  await rename(childLock, `${childLock}.old`);
  await writeFile(childLock, '');
  await assert.rejects(withDeleteLocks({ root, members: fresh, committed: true }, (lease) => lease.remove()), { code: 'collision' });
  assert.equal(await readFile(join(dirs.parent, current), 'utf8'), 'parent');
});

linuxTest('a new generation after the durable write leaves every original group log intact', async (t) => {
  const { root, members, dirs } = await fixture(t);
  const newLog = join(dirs.child, older);
  await assert.rejects(withDeleteLocks({ root, members }, (lease) => lease.remove(() => writeFile(newLog, 'unknown'))), { code: 'collision' });
  assert.equal(await readFile(join(dirs.parent, current), 'utf8'), 'parent');
  assert.equal(await readFile(join(dirs.child, current), 'utf8'), 'child');
  assert.equal(await readFile(newLog, 'utf8'), 'unknown');
});

linuxTest('unknown and symbolic-link artifacts block deletion before any group mutation', async (t) => {
  const { root, members, dirs } = await fixture(t);
  const unexpected = join(dirs.child, 'notes.txt');
  await writeFile(unexpected, 'notes');
  await assert.rejects(withDeleteLocks({ root, members }, () => assert.fail('callback must not run')), { code: 'unsupported' });
  await unlink(unexpected);
  await symlink(join(dirs.other, current), join(dirs.child, older));
  await assert.rejects(withDeleteLocks({ root, members }, () => assert.fail('callback must not run')), { code: 'unsafe-path' });
  assert.equal(await readFile(join(dirs.parent, current), 'utf8'), 'parent');
  assert.equal(await readFile(join(dirs.other, current), 'utf8'), 'other');
});
