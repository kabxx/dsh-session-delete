import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { acquirePathLock, assertPlainWindowsPath, publishPath, syncDirectory, verifyPathLock } from '../src/platform-fs.js';

const supported = process.platform === 'linux' || (
  (process.platform === 'darwin' || process.platform === 'win32')
    && Boolean(process.env.DSH_INSTALL_DIR || process.versions.electron)
);

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const prefix = `${temp}${sep}dsh-native-lock-test-`;
  const path = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.startsWith(prefix) && path.length > prefix.length);
    await rm(path, { force: true, recursive: true });
  });
  return path;
}

test('native leases reject concurrent owners and release afterwards', { skip: !supported }, async (t) => {
  const root = await fixture(t);
  const path = join(root, 'session.lock');
  const first = await acquirePathLock(path);
  try {
    await verifyPathLock(path, first.lockedIdentity);
    await assert.rejects(acquirePathLock(path), { code: 'locked' });
    if (process.platform === 'win32') {
      await assert.rejects(lstat(path), { code: 'ENOENT' });
      await assert.rejects(acquirePathLock(path.toUpperCase()), { code: 'locked' });
    }
  } finally {
    await first.handle.close();
  }
  const next = await acquirePathLock(path);
  try {
    assert.deepEqual(next.lockedIdentity, first.lockedIdentity);
    await assert.rejects(verifyPathLock(path, { ...next.lockedIdentity, ino: 'unrelated' }), { code: 'collision' });
  } finally {
    await next.handle.close();
  }
});

test('native namespace publication preserves collisions and can replace the journal', { skip: !supported }, async (t) => {
  const root = await fixture(t);
  assertPlainWindowsPath(root);
  const oldDirectory = join(root, 'session');
  const newDirectory = join(root, 'staging');
  await mkdir(oldDirectory);
  await writeFile(join(oldDirectory, 'log'), 'source');
  await publishPath(oldDirectory, newDirectory);
  assert.equal(await readFile(join(newDirectory, 'log'), 'utf8'), 'source');
  await assert.rejects(lstat(oldDirectory), { code: 'ENOENT' });
  const journalTemp = join(root, 'journal.temp');
  const journal = join(root, 'journal.json');
  await writeFile(journalTemp, 'new');
  await writeFile(journal, 'old');
  await assert.rejects(publishPath(journalTemp, journal), { code: 'collision' });
  assert.equal(await readFile(journal, 'utf8'), 'old');
  await publishPath(journalTemp, journal, { replace: true });
  await syncDirectory(root);
  assert.equal(await readFile(journal, 'utf8'), 'new');
  await assert.rejects(lstat(journalTemp), { code: 'ENOENT' });
});

test('Windows namespace checks refuse to traverse junctions', {
  skip: process.platform !== 'win32' || !supported,
}, async (t) => {
  const root = await fixture(t);
  const target = join(root, 'other-sessions');
  const junction = join(root, 'junction');
  await mkdir(target);
  await symlink(target, junction, 'junction');
  assertPlainWindowsPath(target);
  assert.throws(() => assertPlainWindowsPath(junction), { code: 'unsafe-path' });
});
