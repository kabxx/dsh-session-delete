import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  directoryTree, isLog, lockName, lockSource, sameIdentity, sourcePath, stat, syncDirectory, verifySource,
} from './online-disk.js';

function refuse(code) {
  throw Object.assign(new Error(`Session deletion: ${code}`), { code });
}

function fingerprint(info, device) {
  if (!info?.isFile() || info.nlink !== 1n) refuse('unsafe-path');
  if (info.dev !== device) refuse('cross-device');
  const bytes = Number(info.size);
  if (!Number.isSafeInteger(bytes)) refuse('unsupported');
  return { dev: String(info.dev), ino: String(info.ino), bytes, mtime: String(info.mtimeNs), ctime: String(info.ctimeNs) };
}

function matches(info, expected, device) {
  const current = fingerprint(info, device);
  return Object.keys(current).every((key) => current[key] === expected[key]);
}

function validPayload(payload) {
  return Array.isArray(payload) && payload.length > 0
    && payload.every((file) => file && isLog(file.name) && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      && ['dev', 'ino', 'mtime', 'ctime'].every((key) => typeof file[key] === 'string' && /^-?\d+$/u.test(file[key])))
    && new Set(payload.map(({ name }) => name)).size === payload.length;
}

async function survey(item, device, planned, allowMissing) {
  await verifySource(item, device);
  const observed = [];
  const expected = planned && new Map(planned.map((file) => [file.name, file]));
  for (const name of (await readdir(item.source)).sort()) {
    if (name === lockName) continue;
    if (!isLog(name)) refuse('unsupported');
    const info = await stat(join(item.source, name));
    if (!info) refuse('collision');
    if (!expected) {
      observed.push({ name, ...fingerprint(info, device) });
      continue;
    }
    const file = expected.get(name);
    if (!file || !matches(info, file, device)) refuse('collision');
    expected.delete(name);
  }
  if (expected) {
    if (expected.size && !allowMissing) refuse('collision');
  } else if (observed.length === 0) {
    refuse('missing');
  }
  return observed;
}

/**
 * Validate a complete group under DSH's native JSONL write leases. A preview
 * callback is read-only for rollout files. For deletion pass the durable journal
 * writer to lease.remove(), or use a previously committed plan on recovery.
 * Keep the original directories and lease inodes to preserve kernel exclusion.
 */
export async function withDeleteLocks({ root, members, committed = false }, run) {
  if (process.platform !== 'linux') refuse('unsupported');
  if (typeof run !== 'function' || typeof committed !== 'boolean' || !Array.isArray(members) || members.length === 0
    || members.some((member) => !member || typeof member.id !== 'string')
    || new Set(members.map(({ id }) => id)).size !== members.length) refuse('bad-state');
  const { dev } = await directoryTree(root, false);
  const items = structuredClone(members).map((member) => ({ member, source: sourcePath(root, member) }));
  const locks = [];
  let active = true;
  let deletion;
  try {
    for (const item of [...items].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0)) {
      locks.push(await lockSource(item, dev));
      if (committed && !sameIdentity(item.lockIdentity, item.member.lockIdentity)) {
        refuse('collision');
      }
    }
    for (const item of items) {
      if (committed) {
        if (!validPayload(item.member.payload)) refuse('bad-state');
        await survey(item, dev, item.member.payload, true);
      } else {
        item.member.payload = await survey(item, dev);
        item.member.lockIdentity = item.lockIdentity;
      }
    }
    const plan = () => structuredClone(items.map(({ member }) => member));
    async function removeGroup(commit) {
      for (const item of items) await survey(item, dev, item.member.payload, committed);
      if (!committed) {
        await commit(plan());
        for (const item of items) await survey(item, dev, item.member.payload, false);
      }
      for (const item of items) {
        for (const file of item.member.payload) {
          await verifySource(item, dev);
          const path = join(item.source, file.name);
          const info = await stat(path);
          if (!info && committed) continue;
          if (!info || !matches(info, file, dev)) refuse('collision');
          await unlink(path);
        }
        await syncDirectory(item.source);
      }
    }
    return await run(Object.freeze({
      members: plan(),
      async remove(commit) {
        if (!active || deletion || (committed ? commit !== undefined : typeof commit !== 'function')) refuse('bad-state');
        deletion = removeGroup(commit);
        return await deletion;
      },
    }));
  } finally {
    active = false;
    await deletion?.catch(() => {});
    await Promise.allSettled(locks.reverse().map((handle) => handle.close()));
  }
}
