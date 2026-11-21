import { lstat, mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { validateSessionLocation } from './disk-trash.js';
import { acquirePathLock, assertPlainWindowsPath, syncDirectory, verifyPathLock } from './platform-fs.js';

const lockName = 'session.lock';
const ticketName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const logName = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/u;
const transitions = {
  move: { start: ['pending'], active: 'moving', done: 'ready' },
  restore: { start: ['ready', 'restore-pending'], active: 'restoring', done: 'restored' },
  purge: { start: ['ready'], active: 'purging', done: 'purged' },
};

function fail(code) {
  throw Object.assign(new Error(`Online session trash: ${code}`), { code });
}

function isLog(name) {
  if (typeof name !== 'string') return false;
  const match = logName.exec(name);
  return !!match && (match[1] === undefined || Number.isSafeInteger(Number(match[1])));
}

async function stat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function identity(info) {
  return { dev: String(info.dev), ino: String(info.ino) };
}

function sameIdentity(info, expected) {
  return info && String(info.dev) === expected?.dev && String(info.ino) === expected?.ino;
}

async function directory(path, device) {
  const info = await stat(path);
  if (info) {
    if (!info.isDirectory()) fail('unsafe-path');
    assertPlainWindowsPath(path);
  }
  if (info && device !== undefined && info.dev !== device) fail('cross-device');
  return info;
}

async function ensureDirectory(path, device, create) {
  let info = await directory(path, device);
  if (!info && create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    info = await directory(path, device);
    await syncDirectory(dirname(path));
  }
  return info;
}

async function directoryTree(path, create) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('unsafe-path');
  let current = parse(path).root;
  let info = await directory(current);
  for (const segment of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    info = await ensureDirectory(current, undefined, create);
    if (!info) fail('missing');
  }
  return info;
}

function within(root, path) {
  const rest = relative(root, path);
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

function sourcePath(root, member) {
  if (typeof member.relative !== 'string' || !member.identity) fail('bad-state');
  const source = resolve(root, ...member.relative.split('/'));
  const canonical = validateSessionLocation(root, member.id, { kind: 'jsonl', path: join(source, 'session.jsonl') });
  if (canonical !== member.relative) fail('unsafe-path');
  return source;
}

async function verifySource(item, device) {
  if (!await directory(dirname(item.source), device)) fail('missing');
  if (!sameIdentity(await directory(item.source, device), item.sourceIdentity ?? item.member.identity)) fail('collision');
  await verifyPathLock(item.lockPath, item.lockIdentity);
}

/** Serialize plugin journal access across processes using the stable lock inode. */
export async function withFileLock(path, callback) {
  if (typeof callback !== 'function') fail('bad-state');
  const parent = await directoryTree(dirname(path), false);
  const { handle } = await acquirePathLock(path, parent.dev);
  try { return await callback(); }
  finally { await handle.close(); }
}

async function lockSource(item, device) {
  if (!await directory(dirname(item.source), device)) fail('missing');
  const source = await directory(item.source, device);
  if (!sameIdentity(source, item.sourceIdentity ?? item.member.identity)) fail('collision');
  item.lockPath = join(item.source, lockName);
  const { handle, lockedIdentity } = await acquirePathLock(item.lockPath, device);
  try {
    item.lockIdentity = lockedIdentity;
    await verifySource(item, device);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function inspectLegacyLock(path) {
  const info = await stat(path);
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1n || info.size !== 0n) fail('unsafe-path');
  return identity(info);
}

async function payloadAt(path, device, allowLock = false) {
  const payload = new Map();
  for (const name of await readdir(path)) {
    if (allowLock && name === lockName) continue;
    if (!isLog(name)) fail('unsupported');
    const info = await stat(join(path, name));
    if (!info?.isFile() || info.nlink !== 1n) fail('unsafe-path');
    if (info.dev !== device) fail('cross-device');
    const bytes = Number(info.size);
    if (!Number.isSafeInteger(bytes)) fail('unsupported');
    payload.set(name, { name, bytes, identity: identity(info) });
  }
  return payload;
}

function verifyPayload(planned, actual) {
  if (actual?.bytes !== planned.bytes || actual?.identity.dev !== planned.identity?.dev
    || actual.identity.ino !== planned.identity?.ino) fail('collision');
}

async function survey(item, device, action, initial) {
  await verifySource(item, device);
  const from = await payloadAt(item.source, device, true);
  const trash = await directory(item.trash, device);
  if (trash && item.member.trashIdentity && !sameIdentity(trash, item.member.trashIdentity)) fail('collision');
  const to = trash ? await payloadAt(item.trash, device, action === 'restore' && !!item.member.legacyLock) : new Map();
  if (trash && action === 'restore' && item.member.legacyLock) {
    const legacyLock = await inspectLegacyLock(join(item.trash, lockName));
    if (legacyLock && (legacyLock.ino !== item.member.legacyLock.ino || legacyLock.dev !== item.member.legacyLock.dev)) {
      fail('collision');
    }
  }
  if (action === 'move' && initial) {
    if (!from.size) fail('missing');
    if (to.size) fail('collision');
    return { from, to, payload: [...from.values()] };
  }
  const payload = item.member.payload;
  if (!Array.isArray(payload) || payload.length === 0
    || payload.some((file) => !isLog(file?.name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)
    || new Set(payload.map(({ name }) => name)).size !== payload.length) fail('bad-state');
  const planned = new Set(payload.map(({ name }) => name));
  for (const name of [...from.keys(), ...to.keys()]) if (!planned.has(name)) fail('collision');
  for (const file of payload) {
    const native = from.get(file.name);
    const trashed = to.get(file.name);
    if (native && trashed) fail('collision');
    if (action !== 'move' && initial && native) fail('collision');
    if (action === 'purge' && native) fail('collision');
    if (!native && !trashed && !(action === 'purge' && !initial)) fail('missing');
    if (native || trashed) verifyPayload(file, native ?? trashed);
  }
  return { from, to, payload };
}

async function mutate(item, device, action) {
  // Revalidate both directories and every file before mutating this member.
  const { from, to, payload } = await survey(item, device, action, false);
  for (const file of payload) {
    const original = join(item.source, file.name);
    const trashed = join(item.trash, file.name);
    if (action === 'move' && from.has(file.name)) {
      await rename(original, trashed);
    } else if (action === 'restore' && to.has(file.name)) {
      await rename(trashed, original);
    } else if (action === 'purge' && to.has(file.name)) {
      await unlink(trashed);
    }
  }
  await syncDirectory(item.source);
  if (await directory(item.trash, device)) {
    if (action === 'restore' && item.member.legacyLock) {
      const legacyPath = join(item.trash, lockName);
      const oldLease = await inspectLegacyLock(legacyPath);
      if (oldLease) {
        if (oldLease.ino !== item.member.legacyLock.ino || oldLease.dev !== item.member.legacyLock.dev) fail('collision');
        await unlink(legacyPath);
      }
    }
    await syncDirectory(item.trash);
    if (action !== 'move') await rmdir(item.trash);
  }
  item.member.disk = action === 'move' ? 'trash' : action === 'restore' ? 'source' : 'deleted';
}

// The direct-delete path shares the stock JSONL lease and path validation.
export { directoryTree, isLog, lockName, lockSource, sameIdentity, sourcePath, stat, syncDirectory, verifySource };

/** Move only generation files. The original directory and its native lease inode stay in place. */
export async function runOnlineDiskOperation(entry, { root, trashRoot, save, preflight }, action) {
  if (process.platform !== 'linux') fail('unsupported');
  const transition = Object.hasOwn(transitions, action) && transitions[action];
  if (!transition || typeof save !== 'function' || !ticketName.test(entry?.ticket ?? '')
    || !Array.isArray(entry.members) || !entry.members.length || entry.members[0]?.id !== entry.id) fail('bad-state');
  if (entry.phase === transition.done) return entry;
  const initial = transition.start.includes(entry.phase);
  const legacyRestore = action === 'restore' && initial && entry.layout === undefined;
  if ((!initial && entry.phase !== transition.active)
    || (entry.layout !== 'online' && !legacyRestore && (!initial || action !== 'move'))) fail('bad-state');
  const rootInfo = await directoryTree(root, false);
  if (typeof trashRoot !== 'string' || within(root, trashRoot) || within(trashRoot, root)) fail('unsafe-path');
  const device = rootInfo.dev;
  if ((await directoryTree(trashRoot, action === 'move')).dev !== device) fail('cross-device');
  const ticketDir = join(trashRoot, entry.ticket);
  const items = entry.members.map((member) => {
    const source = sourcePath(root, member);
    return { member, source, trash: join(ticketDir, source.slice(source.lastIndexOf(sep) + 1)) };
  });
  const names = new Set(items.map(({ trash }) => trash.slice(trash.lastIndexOf(sep) + 1)));
  if (names.size !== items.length || new Set(entry.members.map(({ id }) => id)).size !== items.length) fail('bad-state');
  const locks = [];
  try {
    if (legacyRestore) {
      // The previous version renamed complete directories. Recreate empty
      // source stubs and lock them, then transfer only the checked old payload.
      for (const item of items) {
        if (!sameIdentity(await directory(item.trash, device), item.member.identity)) fail('collision');
        await ensureDirectory(dirname(item.source), device, true);
        const source = await ensureDirectory(item.source, device, true);
        item.sourceIdentity = identity(source);
      }
    }
    for (const item of [...items].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0)) {
      locks.push(await lockSource(item, device));
    }
    const ticket = await ensureDirectory(ticketDir, device, action === 'move' && initial);
    if (ticket) {
      if (entry.ticketIdentity && !sameIdentity(ticket, entry.ticketIdentity)) fail('collision');
      for (const name of await readdir(ticketDir)) if (!names.has(name)) fail('collision');
    } else if (action === 'move' || initial) {
      fail('missing');
    }
    const payloads = [];
    for (const item of items) {
      if (legacyRestore) {
        await verifySource(item, device);
        if ((await payloadAt(item.source, device, true)).size
          || !sameIdentity(await directory(item.trash, device), item.member.identity)) fail('collision');
        const payload = [...(await payloadAt(item.trash, device, true)).values()];
        if (!payload.length) fail('missing');
        payloads.push({ payload, legacyLock: await inspectLegacyLock(join(item.trash, lockName)) });
      } else {
        payloads.push(await survey(item, device, action, initial));
      }
    }
    await preflight?.({ action, entry });
    if (legacyRestore) {
      for (const [index, item] of items.entries()) {
        const { payload, legacyLock } = payloads[index];
        item.member.trashIdentity = item.member.identity;
        item.member.identity = item.sourceIdentity;
        item.member.payload = payload;
        item.member.legacyLock = legacyLock;
      }
      entry.ticketIdentity = identity(ticket);
      entry.layout = 'online';
    }
    if (action === 'move' && initial) {
      let bytes = 0;
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const { payload } = payloads[index];
        item.member.payload = payload;
        item.member.bytes = payload.reduce((total, file) => total + file.bytes, 0);
        item.member.disk = 'source';
        bytes += item.member.bytes;
        const trash = await ensureDirectory(item.trash, device, true);
        item.member.trashIdentity = identity(trash);
      }
      if (!Number.isSafeInteger(bytes)) fail('unsupported');
      entry.ticketIdentity = identity(ticket);
      entry.layout = 'online';
      entry.bytes = bytes;
    }
    if (initial) {
      entry.phase = transition.active;
      await save(entry);
    }
    for (const item of items) {
      await mutate(item, device, action);
      if (await directory(ticketDir, device)) await syncDirectory(ticketDir);
      await save(entry);
    }
    if (action !== 'move') {
      if (await directory(ticketDir, device)) await rmdir(ticketDir);
      await syncDirectory(trashRoot);
    }
    entry.phase = transition.done;
    await save(entry);
    return entry;
  } finally {
    await Promise.allSettled(locks.reverse().map((handle) => handle.close()));
  }
}
