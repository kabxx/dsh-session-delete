import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { captureDirectory, withDirectoryLocks } from '../src/delete-tree.js';
import { withFileLock } from '../src/online-disk.js';

const linuxTest = (name, body) => test(name, { skip: process.platform !== 'linux' }, body);
const log = 'session.v4.jsonl.zstd';
const lock = 'session.lock';

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'dsh-directory-delete-'));
  t.after(() => rm(base, { recursive: true }));
  const root = join(base, 'sessions');
  const staging = join(base, 'delete-intents');
  const dirs = Object.fromEntries(['parent', 'child', 'other'].map((id) => [id, join(root, '--project--', id)]));
  for (const [id, dir] of Object.entries(dirs)) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, log), id);
    await writeFile(join(dir, lock), '');
  }
  const members = await Promise.all(['parent', 'child'].map((id) => captureDirectory(root, id, { kind: 'jsonl', path: join(dirs[id], log) })));
  return { root, staging, members, dirs };
}

linuxTest('removes whole verified directories, including sidecars and links, without following links', async (t) => {
  const { dirs, ...input } = await fixture(t);
  await writeFile(join(dirs.parent, 'session.v2.jsonl'), 'old rollout');
  await mkdir(join(dirs.child, 'plugin'));
  await writeFile(join(dirs.child, 'plugin', 'note.txt'), 'sidecar');
  await symlink(dirs.other, join(dirs.child, 'plugin', 'outside'));
  await withDirectoryLocks(input, ({ remove }) => remove(async (plan) => {
    assert.ok(plan.transaction);
    assert.equal(await readFile(join(dirs.parent, log), 'utf8'), 'parent');
    await assert.rejects(withFileLock(join(dirs.child, lock), () => {}), { code: 'locked' });
  }));
  for (const id of ['parent', 'child']) await assert.rejects(lstat(dirs[id]), { code: 'ENOENT' });
  assert.equal(await readFile(join(dirs.other, log), 'utf8'), 'other');
  assert.deepEqual(await readdir(input.staging), []);
});

linuxTest('a live writer or failed journal leaves both directories untouched', async (t) => {
  const { dirs, ...input } = await fixture(t);
  await withFileLock(join(dirs.child, lock), () => assert.rejects(withDirectoryLocks(input, () => assert.fail()), { code: 'locked' }));
  await assert.rejects(withDirectoryLocks(input, ({ remove }) => remove(() => { throw Error('durability'); })), /durability/u);
  assert.equal(await readFile(join(dirs.parent, log), 'utf8'), 'parent');
  assert.equal(await readFile(join(dirs.child, log), 'utf8'), 'child');
});

linuxTest('recovery removes staged identities and never a replacement at the original path', async (t) => {
  const { dirs, ...input } = await fixture(t);
  let committed;
  await assert.rejects(withDirectoryLocks(input, ({ remove }) => remove((plan) => {
    committed = plan;
    throw Error('simulate power loss after journal');
  })), /simulate power loss/u);
  const detached = join(input.staging, committed.transaction, '0');
  await mkdir(input.staging, { mode: 0o700 });
  await mkdir(dirname(detached), { mode: 0o700 });
  await rename(dirs.parent, detached);
  await mkdir(dirs.parent);
  await writeFile(join(dirs.parent, log), 'replacement');
  await withDirectoryLocks({ ...input, ...committed }, ({ remove }) => remove());
  await assert.rejects(lstat(detached), { code: 'ENOENT' });
  await assert.rejects(lstat(dirs.child), { code: 'ENOENT' });
  assert.equal(await readFile(join(dirs.parent, log), 'utf8'), 'replacement');
  await withDirectoryLocks({ ...input, ...committed }, ({ remove }) => remove());
  assert.equal(await readFile(join(dirs.parent, log), 'utf8'), 'replacement');
});

linuxTest('rejects a foreign directory using an existing staging transaction', async (t) => {
  const { dirs, ...input } = await fixture(t);
  const transaction = randomUUID();
  await mkdir(input.staging, { mode: 0o700 });
  await mkdir(join(input.staging, transaction, '0'), { recursive: true, mode: 0o700 });
  const file = join(input.staging, transaction, '0', log);
  await writeFile(file, 'foreign data');
  await assert.rejects(withDirectoryLocks({ ...input, transaction }, () => assert.fail()), { code: 'collision' });
  assert.equal(await readFile(file, 'utf8'), 'foreign data');
  assert.equal(await readFile(join(dirs.parent, log), 'utf8'), 'parent');
});
