import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  return child === path || child.startsWith(path + sep);
}

async function assertNoMounts(paths) {
  const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
  for (const line of mountInfo.trim().split('\n')) {
    const mountPath = line.split(' ')[4]?.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!mountPath?.startsWith('/')) refuse('unsupported');
    if (paths.some((path) => contains(path, mountPath))) refuse('cross-device');
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
  if (info && (!info.isDirectory() || info.dev !== device || info.uid !== BigInt(process.getuid())
    || (info.mode & 0o077n) !== 0n)) refuse('unsafe-path');
  return info;
}

/** Keep the original native lock until the entire verified directory is detached. */
export async function withDirectoryLocks({ root, staging, members, transaction, previewResidents }, run) {
  if (process.platform !== 'linux') refuse('unsupported');
  const committed = transaction !== undefined;
  if ((committed && !transactionId.test(transaction)) || !Array.isArray(members) || !members.length
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
      if (detached || (committed && !current)) continue;
      if (!sameIdentity(current, item.member.identity)) {
        if (committed) continue;
        refuse('collision');
      }
      if (!previewResidents?.has(item.member.id)) locks.push(await lockSource(item, device));
      item.files = await rolloutFingerprint(item);
      if (committed && (!sameIdentity(item.lockIdentity, item.member.lockIdentity)
        || JSON.stringify(item.files) !== JSON.stringify(item.member.files))) refuse('collision');
    }
    const fingerprint = JSON.stringify(items.map(({ member, files }) => [member.id, files]));
    const plan = items.map(({ member, files, lockIdentity }) => ({ ...member, files, lockIdentity }));
    return await run({ fingerprint, async remove(commit) {
      if (previewResidents) refuse('bad-state');
      if (!committed) await commit({ members: plan, transaction: basename(transactionPath) });
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
        await rename(item.source, item.detached);
        await syncDirectory(dirname(item.source));
        await syncDirectory(transactionPath);
      }
      await assertNoMounts([transactionPath]);
      for (const item of items) {
        const detached = await stat(item.detached);
        if (!detached) continue;
        if (!detached.isDirectory() || !sameIdentity(detached, item.member.identity)) refuse('collision');
        // fs.rm unlinks symlinks inside this directory without visiting their targets.
        await rm(item.detached, { recursive: true });
        await syncDirectory(transactionPath);
      }
      await rmdir(transactionPath);
      await syncDirectory(staging);
    } });
  } finally {
    await Promise.allSettled(locks.reverse().map((handle) => handle.close()));
  }
}
