import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquirePathLock, assertPlainWindowsPath, publishPath, restorePath, verifyPathLock } from './platform-fs.js';
import { validateSessionLocation } from './disk-trash.js';
import { directoryTree, isLog, lockSource, sameIdentity, sourcePath, stat, syncDirectory, verifySource } from './online-disk.js';

const transactionId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const identityPart = /^\d+$/u;

function refuse(code) {
  throw Object.assign(new Error(`Session directory deletion: ${code}`), { code });
}

function identity(info) {
  return { dev: String(info.dev), ino: String(info.ino) };
}

function contains(path, child) {
  if (process.platform === 'darwin') {
    path = path.normalize('NFC').toLowerCase();
    child = child.normalize('NFC').toLowerCase();
  }
  const remainder = relative(path, child);
  return remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

async function assertNoMounts(paths) {
  let mounts;
  if (process.platform === 'linux') {
    const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
    mounts = mountInfo.trimEnd().split('\n').map((line) => {
      const path = line.split(' ')[4]?.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
      if (!path?.startsWith('/')) refuse('unsupported');
      return path;
    });
  } else if (process.platform === 'darwin') {
    const { stdout } = await promisify(execFile)('/sbin/mount', { timeout: 4000 });
    mounts = stdout.trimEnd().split('\n').flatMap((line) => {
      const end = line.lastIndexOf(' (');
      if (end < 0 || !line.endsWith(')')) refuse('unsupported');
      const prefix = line.slice(0, end);
      const candidates = [...prefix.matchAll(/ on (?=\/)/gu)].map(({ index }) => prefix.slice(index + 4));
      if (!candidates.length) refuse('unsupported');
      return candidates;
    });
  } else if (process.platform === 'win32') {
    // Win32 mount points and junctions are reparse points, checked before recursion.
    return;
  } else refuse('unsupported');
  if (paths.some((path) => mounts.some((mount) => contains(path, mount)))) refuse('cross-device');
}

async function inspectDeletionTree(path, device) {
  const pending = [path];
  while (pending.length) {
    const current = pending.pop();
    const info = await stat(current);
    if (!info) refuse('changed');
    // Node unlinks symbolic links (including junctions) without traversing them.
    if (info.isSymbolicLink()) continue;
    assertPlainWindowsPath(current);
    if (info.dev !== device) refuse('cross-device');
    if (info.isDirectory()) {
      for (const name of await readdir(current)) pending.push(join(current, name));
    }
  }
}

export async function captureDirectory(root, id, location) {
  const relativePath = validateSessionLocation(root, id, location);
  const device = (await directoryTree(root, false)).dev;
  const info = await directoryTree(dirname(location.path), false);
  if (info.dev !== device) refuse('cross-device');
  return { id, relative: relativePath, identity: identity(info) };
}

async function rolloutFingerprint(item) {
  const files = [];
  for (const name of (await readdir(item.source)).sort()) {
    if (!isLog(name)) continue;
    const info = await stat(join(item.source, name));
    if (!info?.isFile() || info.nlink !== 1n || info.dev !== item.device) refuse('unsafe-path');
    assertPlainWindowsPath(join(item.source, name));
    files.push([name, String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]);
  }
  if (!files.length) refuse('missing');
  return files;
}

async function privateDirectory(path, device, create) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(dirname(path));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const info = await stat(path);
  if (info && (!info.isDirectory() || info.dev !== device)) refuse('unsafe-path');
  if (info) assertPlainWindowsPath(path);
  if (info && process.platform !== 'win32'
    && (info.uid !== BigInt(process.getuid()) || (info.mode & 0o077n) !== 0n)) refuse('unsafe-path');
  return info;
}

/** Keep the original native lock until the entire verified directory is detached. */
export async function withDirectoryLocks({ root, staging, members, transaction, phase, previewResidents }, run) {
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) refuse('unsupported');
  const committed = transaction !== undefined;
  if ((phase !== undefined && (!committed || !['prepared', 'committed'].includes(phase)))
    || (committed && !transactionId.test(transaction)) || !Array.isArray(members) || !members.length
    || members.some((member) => typeof member?.id !== 'string' || !identityPart.test(member.identity?.dev)
      || !identityPart.test(member.identity?.ino)) || new Set(members.map(({ id }) => id)).size !== members.length) {
    refuse('bad-state');
  }
  if (resolve(staging) !== staging || contains(root, staging) || contains(staging, root)) refuse('unsafe-path');
  const device = (await directoryTree(root, false)).dev;
  if ((await directoryTree(dirname(staging), false)).dev !== device) refuse('cross-device');
  const transactionPath = join(staging, transaction ?? randomUUID());
  const items = structuredClone(members).map((member, index) => ({
    member, device, source: sourcePath(root, member), detached: join(transactionPath, String(index)),
    replacement: join(transactionPath, `${index}.replacement`),
  }));
  const locks = [];
  try {
    await assertNoMounts([staging, ...items.map(({ source }) => source)]);
    await privateDirectory(staging, device, false);
    if (await privateDirectory(transactionPath, device, false) && !committed) refuse('collision');
    for (const item of [...items].sort((a, b) => a.source.localeCompare(b.source))) {
      const detached = await stat(item.detached);
      if (detached && (!committed || !detached.isDirectory() || !sameIdentity(detached, item.member.identity))) refuse('collision');
      if ((await directoryTree(dirname(item.source), false)).dev !== device) refuse('cross-device');
      const current = await stat(item.source);
      if (phase === 'prepared') continue;
      if (phase === 'committed') {
        if (sameIdentity(current, item.member.identity)) refuse('collision');
        continue;
      }
      if (detached || (committed && !current)) continue;
      if (!sameIdentity(current, item.member.identity)) {
        if (committed) continue;
        refuse('collision');
      }
      if (!previewResidents?.has(item.member.id)) locks.push(await lockSource(item, device));
      item.files = await rolloutFingerprint(item);
      await inspectDeletionTree(item.source, device);
      if (committed && (!sameIdentity(item.lockIdentity, item.member.lockIdentity)
        || JSON.stringify(item.files) !== JSON.stringify(item.member.files))) refuse('collision');
    }
    const fingerprint = JSON.stringify(items.map(({ member, files }) => [member.id, files]));
    const plan = items.map(({ member, files, lockIdentity }) => ({ ...member, files, lockIdentity }));
    async function detach() {
      await assertNoMounts([staging, ...items.map(({ source }) => source)]);
      await privateDirectory(staging, device, true);
      await privateDirectory(transactionPath, device, true);
      for (const item of items) {
        if (!item.files) continue;
        await verifySource(item, device);
        if (JSON.stringify(await rolloutFingerprint(item)) !== JSON.stringify(item.files)) refuse('changed');
        if (await stat(item.detached)) refuse('collision');
      }
      for (const item of items) {
        if (!item.files) continue;
        await verifySource(item, device);
        await publishPath(item.source, item.detached);
        await syncDirectory(dirname(item.source));
        await syncDirectory(transactionPath);
      }
      await syncDirectory(staging);
      await syncDirectory(dirname(staging));
    }

    async function clearStaging() {
      if (!await privateDirectory(transactionPath, device, false)) return;
      await assertNoMounts([transactionPath]);
      for (const item of items) {
        const detached = await stat(item.detached);
        if (!detached) continue;
        if (!detached.isDirectory() || !sameIdentity(detached, item.member.identity)) refuse('collision');
        await inspectDeletionTree(item.detached, device);
        await rm(item.detached, { recursive: true });
        await syncDirectory(transactionPath);
      }
      await rmdir(transactionPath);
      await syncDirectory(staging);
    }

    async function rollback() {
      if (phase !== 'prepared') refuse('bad-state');
      for (const item of [...items].reverse()) {
        const detached = await stat(item.detached);
        if (detached) {
          if (!detached.isDirectory() || !sameIdentity(detached, item.member.identity)) refuse('collision');
          const movedItem = { ...item, source: item.detached };
          const restore = async () => {
            if (JSON.stringify(await rolloutFingerprint(movedItem)) !== JSON.stringify(item.member.files)) refuse('changed');
            if (!sameIdentity(await stat(item.detached), item.member.identity)) refuse('collision');
            const discardReplacement = async (sourceIdentity, lockIdentity) => {
              await assertNoMounts([item.replacement]);
              await inspectDeletionTree(item.replacement, device);
              if (!sameIdentity(await stat(item.replacement), sourceIdentity)) refuse('collision');
              if (lockIdentity) await verifyPathLock(join(item.replacement, 'session.lock'), lockIdentity);
              await rm(item.replacement, { recursive: true });
              await syncDirectory(transactionPath);
            };
            const posix = process.platform !== 'win32';
            // Windows already holds the original path's semaphore throughout restore.
            // On POSIX the replacement has its own lock inode, distinct from the original.
            const stagedReplacement = await stat(item.replacement);
            if (stagedReplacement) {
              if (!stagedReplacement.isDirectory() || stagedReplacement.dev !== device) refuse('unsafe-path');
              assertPlainWindowsPath(item.replacement);
              const conflict = { source: item.replacement, sourceIdentity: identity(stagedReplacement) };
              if (posix) locks.push(await lockSource(conflict, device));
              await discardReplacement(conflict.sourceIdentity, conflict.lockIdentity);
            }
            const occupant = await stat(item.source);
            if (occupant) {
              if (!occupant.isDirectory() || occupant.dev !== device) refuse('unsafe-path');
              assertPlainWindowsPath(item.source);
              await assertNoMounts([item.source]);
              const conflict = { source: item.source, sourceIdentity: identity(occupant) };
              if (posix) {
                locks.push(await lockSource(conflict, device));
                await verifySource(conflict, device);
              } else if (!sameIdentity(await stat(item.source), conflict.sourceIdentity)) refuse('collision');
              await publishPath(item.source, item.replacement);
              await syncDirectory(dirname(item.source));
              await syncDirectory(transactionPath);
              await discardReplacement(conflict.sourceIdentity, conflict.lockIdentity);
            }
            await restorePath(item.detached, item.source);
            await syncDirectory(transactionPath);
          };
          if (process.platform === 'win32') {
            // The DSH semaphore is keyed by the original path, even while that directory is absent.
            const { handle } = await acquirePathLock(join(item.source, 'session.lock'));
            try { await restore(); }
            finally { await handle.close(); }
          } else {
            const handle = await lockSource(movedItem, device);
            try {
              if (!sameIdentity(movedItem.lockIdentity, item.member.lockIdentity)) refuse('collision');
              await restore();
            } finally { await handle.close(); }
          }
        }
        if (!sameIdentity(await stat(item.source), item.member.identity)) refuse('collision');
        await syncDirectory(dirname(item.source));
      }
      if (await privateDirectory(transactionPath, device, false)) await rmdir(transactionPath);
      if (await privateDirectory(staging, device, false)) await syncDirectory(staging);
    }

    return await run({ fingerprint, rollback, async remove(callbacks) {
      if (previewResidents || phase === 'prepared') refuse('bad-state');
      if (phase !== 'committed') {
        if (!committed) {
          const prepare = typeof callbacks === 'function' ? callbacks : callbacks.prepare;
          await prepare({ members: plan, transaction: basename(transactionPath) });
        }
        await detach();
        if (!committed && typeof callbacks !== 'function') {
          for (const item of items) {
            if (!sameIdentity(await stat(item.detached), item.member.identity)) refuse('collision');
          }
          await callbacks.commit();
        }
      }
      await clearStaging();
    } });
  } finally {
    await Promise.allSettled(locks.reverse().map((handle) => handle.close()));
  }
}
