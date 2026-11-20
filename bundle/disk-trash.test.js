import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { captureSessionMember, runDiskOperation, validateSessionLocation } from './disk-trash.js';

async function fixture(t) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'dsh-disk-trash-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'sessions');
  const trashRoot = join(home, 'session-delete', 'files');
  const project = join(root, '--repo--');
  const logs = {};
  for (const id of ['main', 'child', 'other']) {
    logs[id] = join(project, id, 'session.v4.jsonl.zstd');
    await mkdir(dirname(logs[id]), { recursive: true });
    await writeFile(logs[id], id);
  }
  await writeFile(join(dirname(logs.main), 'session.v3.jsonl.zstd'), 'earlier log');
  const members = [];
  for (const id of ['main', 'child']) {
    members.push(await captureSessionMember(root, id, { kind: 'jsonl', path: logs[id] }));
  }
  const entry = { id: 'main', ticket: randomUUID(), phase: 'pending', members };
  let journal = structuredClone(entry);
  const disk = { root, trashRoot, save: async (snapshot) => { journal = structuredClone(snapshot); } };
  return { root, trashRoot, project, logs, entry, disk, journal: () => structuredClone(journal) };
}

async function fileMissing(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

test('moves full session directories, restores them and later permanently removes their offline copies', async (t) => {
  const { entry, disk, trashRoot, logs, journal } = await fixture(t);
  const ticket = join(trashRoot, entry.ticket);
  await runDiskOperation(entry, disk, 'move');
  assert.equal(journal().phase, 'ready');
  assert.equal(entry.bytes, Buffer.byteLength('mainchildearlier log'));
  await fileMissing(logs.main);
  await fileMissing(logs.child);
  assert.equal(await readFile(join(ticket, 'main', 'session.v3.jsonl.zstd'), 'utf8'), 'earlier log');
  assert.equal(await readFile(join(ticket, 'child', 'session.v4.jsonl.zstd'), 'utf8'), 'child');
  assert.equal(await readFile(logs.other, 'utf8'), 'other');
  const restorable = journal();
  restorable.phase = 'restore-pending';
  await runDiskOperation(restorable, disk, 'restore');
  assert.equal(journal().phase, 'restored');
  assert.equal(await readFile(logs.main, 'utf8'), 'main');
  assert.equal(await readFile(logs.child, 'utf8'), 'child');
  await fileMissing(ticket);
  restorable.phase = 'pending';
  await runDiskOperation(restorable, disk, 'move');
  await runDiskOperation(restorable, disk, 'purge');
  assert.equal(journal().phase, 'purged');
  assert.deepEqual(journal().members.map((member) => member.disk), ['deleted', 'deleted']);
  await fileMissing(logs.main);
  await fileMissing(logs.child);
  await fileMissing(ticket);
  assert.equal(await readFile(logs.other, 'utf8'), 'other');
});

test('resumes moves, restores, and permanent deletion from the journal after a lost progress save', async (t) => {
  const { entry, disk, logs, journal } = await fixture(t);
  const failAfterFirstMutation = (action) => {
    let calls = 0;
    return { ...disk, save: async (snapshot) => {
      calls++;
      if (calls === 2) throw new Error(`injected interruption during ${action}`);
      return disk.save(snapshot);
    } };
  };
  await assert.rejects(runDiskOperation(entry, failAfterFirstMutation('move'), 'move'), /injected interruption/);
  await fileMissing(logs.main);
  assert.equal(await readFile(logs.child, 'utf8'), 'child');
  await runDiskOperation(journal(), disk, 'move');
  const restorable = journal();
  restorable.phase = 'restore-pending';
  await assert.rejects(runDiskOperation(restorable, failAfterFirstMutation('restore'), 'restore'), /injected interruption/);
  assert.equal(await readFile(logs.main, 'utf8'), 'main');
  await fileMissing(logs.child);
  await runDiskOperation(journal(), disk, 'restore');
  const roundtrip = journal();
  roundtrip.phase = 'pending';
  await runDiskOperation(roundtrip, disk, 'move');
  await assert.rejects(runDiskOperation(roundtrip, failAfterFirstMutation('purge'), 'purge'), /injected interruption/);
  await runDiskOperation(journal(), disk, 'purge');
  assert.equal(journal().phase, 'purged');
  await fileMissing(logs.main);
  await fileMissing(logs.child);
});

test('finishes removing a partially deleted directory from a durably committed purge', async (t) => {
  const { entry, disk, trashRoot, logs, journal } = await fixture(t);
  await runDiskOperation(entry, disk, 'move');
  const ticket = join(trashRoot, entry.ticket);
  await assert.rejects(runDiskOperation(entry, { ...disk, save: async (snapshot) => {
    await disk.save(snapshot);
    throw new Error('interruption after committing the purge');
  } }, 'purge'), /interruption after committing/);
  assert.equal(journal().phase, 'purging');
  await rm(join(ticket, 'main', 'session.v3.jsonl.zstd'));
  await rm(join(ticket, 'main', 'session.v4.jsonl.zstd'));
  await runDiskOperation(journal(), disk, 'purge');
  assert.equal(journal().phase, 'purged');
  await fileMissing(ticket);
  assert.equal(await readFile(logs.other, 'utf8'), 'other');
});

test('preflights every member and refuses a replaced directory, preserving both originals', async (t) => {
  const { entry, disk, logs, journal } = await fixture(t);
  await rename(dirname(logs.child), `${dirname(logs.child)}-saved`);
  await mkdir(dirname(logs.child));
  await writeFile(logs.child, 'unrelated');
  await assert.rejects(runDiskOperation(entry, disk, 'move'), { code: 'collision' });
  assert.equal(await readFile(logs.main, 'utf8'), 'main');
  assert.equal(await readFile(logs.child, 'utf8'), 'unrelated');
  assert.equal(await readFile(join(`${dirname(logs.child)}-saved`, 'session.v4.jsonl.zstd'), 'utf8'), 'child');
  assert.equal(journal().phase, 'pending');
});

test('protects restored destinations from empty-directory collisions', async (t) => {
  const { entry, disk, logs, trashRoot } = await fixture(t);
  await runDiskOperation(entry, disk, 'move');
  await mkdir(dirname(logs.child));
  entry.phase = 'restore-pending';
  await assert.rejects(runDiskOperation(entry, disk, 'restore'), { code: 'collision' });
  await fileMissing(logs.main);
  assert.equal(await readFile(join(trashRoot, entry.ticket, 'main', 'session.v4.jsonl.zstd'), 'utf8'), 'main');
});

test('rejects symlinks, paths outside the JSONL root and mismatched IDs', { skip: process.platform === 'win32' }, async (t) => {
  const { entry, disk, logs, root, trashRoot } = await fixture(t);
  await symlink(logs.other, join(dirname(logs.child), 'outside-link'));
  await assert.rejects(runDiskOperation(entry, disk, 'move'), { code: 'unsafe-path' });
  await assert.rejects(runDiskOperation(entry, { ...disk, trashRoot: join(root, 'nested') }, 'move'), { code: 'unsafe-path' });
  assert.throws(() => validateSessionLocation(root, 'main', { kind: 'jsonl', path: logs.other }), { code: 'unsafe-path' });
  assert.throws(() => validateSessionLocation(root, 'main', { kind: 'jsonl', path: join(trashRoot, 'session.v4.jsonl.zstd') }), { code: 'unsafe-path' });
  assert.throws(() => validateSessionLocation(root, 'main', { kind: 'sqlite', path: logs.main }), { code: 'unsupported' });
  assert.equal(await readFile(logs.main, 'utf8'), 'main');
  assert.equal(await readFile(logs.other, 'utf8'), 'other');
});
