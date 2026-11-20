import { lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const generationName = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/u;
const projectName = /^(?:_no-cwd|--[A-Za-z0-9._~-]{1,251}--)$/u;
const ticketName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const dosDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function isGeneration(name) {
  const match = generationName.exec(name);
  return !!match && (match[1] === undefined || Number.isSafeInteger(Number(match[1])));
}

function fail(code) {
  throw Object.assign(new Error(`Session disk trash: ${code}`), { code });
}

// Match DSH JSONL's UTF-16 segment encoding, including lone surrogates.
function encodeId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 200) fail('unsafe-path');
  if (id === '.') return '~002E';
  if (id === '..') return '~002E~002E';
  return id.replace(/[^A-Za-z0-9._-]/gu, (part) => part.split('').map((unit) =>
    `~${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(''));
}

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    fail('unsafe-path');
  }
  return path;
}

function within(root, path) {
  const rest = relative(root, path);
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

function memberParts(id, path) {
  if (typeof path !== 'string') fail('unsafe-path');
  const parts = path.split('/');
  if (parts.length !== 2 || !projectName.test(parts[0]) || parts[1] !== encodeId(id)
    || Buffer.byteLength(parts[1]) > 255) fail('unsafe-path');
  if (process.platform === 'win32' && (dosDeviceName.test(parts[1]) || parts[1].endsWith('.'))) {
    fail('unsafe-path');
  }
  return parts;
}

/** Derive the relative directory only from a path returned by the DSH JSONL service. */
export function validateSessionLocation(root, id, location) {
  absolute(root);
  if (location?.kind !== 'jsonl') fail('unsupported');
  const path = absolute(location.path);
  const directory = dirname(path);
  if (!isGeneration(basename(path)) || !within(root, directory)) fail('unsafe-path');
  const port = relative(root, directory).split(sep).join('/');
  memberParts(id, port);
  return port;
}

async function readStat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkDevice(stat, device) {
  if (stat?.dev !== device) fail('cross-device');
}

async function checkDirectory(path) {
  const stat = await readStat(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('unsafe-path');
  return stat;
}

async function ensureDirectoryTree(path, create) {
  const start = parse(path).root;
  let current = start;
  let stat = await checkDirectory(start);
  for (const part of path.slice(start.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    stat = await checkDirectory(current);
    if (!stat) {
      if (!create) fail('missing');
      await makeDirectory(current);
      stat = await checkDirectory(current);
    }
  }
  if (!stat) fail('missing');
  return stat;
}

async function makeDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(dirname(path));
  } catch (error) {
    // A prior retry may have created this component before persisting the journal.
    if (error.code !== 'EEXIST') throw error;
  }
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function checkIdentity(expected, stat) {
  const actual = identity(stat);
  if (expected?.dev !== actual.dev || expected?.ino !== actual.ino) fail('collision');
}

async function inspectMember(path, stat, device, requireLog) {
  const children = await readdir(path);
  let size = 0n;
  let hasLog = false;
  for (const name of children) {
    const child = await readStat(join(path, name));
    if (!child?.isFile() || child.isSymbolicLink()) fail('unsafe-path');
    checkDevice(child, device);
    if (isGeneration(name)) hasLog = true;
    size += child.size;
  }
  if (requireLog && !hasLog) fail('missing');
  const still = await checkDirectory(path);
  if (!still) fail('missing');
  checkIdentity(identity(stat), still);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) fail('unsupported');
  return Number(size);
}

/** Capture the source directory identity if the Host wants to pin it at queue time. */
export async function captureSessionMember(root, id, location) {
  const port = validateSessionLocation(root, id, location);
  const rootStat = await ensureDirectoryTree(root, false);
  const path = join(root, ...memberParts(id, port));
  const parentStat = await checkDirectory(dirname(path));
  const stat = parentStat && await checkDirectory(path);
  if (!stat) fail('missing');
  checkDevice(stat, rootStat.dev);
  checkDevice(parentStat, rootStat.dev);
  const log = await readStat(location.path);
  if (!log?.isFile() || log.isSymbolicLink()) fail('unsafe-path');
  checkDevice(log, rootStat.dev);
  return { id, relative: port, identity: identity(stat) };
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function locations(root, ticketDir, member, device, requireLog) {
  const parts = memberParts(member.id, member.relative);
  const source = join(root, ...parts);
  const trash = join(ticketDir, parts[1]);
  const project = dirname(source);
  const projectStat = await checkDirectory(project);
  const existingSource = projectStat && await checkDirectory(source);
  const existingTrash = await checkDirectory(trash);
  if (projectStat) checkDevice(projectStat, device);
  if (existingSource && existingTrash) fail('collision');
  const found = existingSource ?? existingTrash;
  if (!found) return { source, trash, project, projectExists: !!projectStat, placement: 'deleted' };
  checkDevice(found, device);
  if (member.identity) checkIdentity(member.identity, found);
  const placement = existingSource ? 'source' : 'trash';
  const bytes = await inspectMember(placement === 'source' ? source : trash, found, device, requireLog);
  return { source, trash, project, projectExists: !!projectStat, placement, bytes, identity: identity(found) };
}

const transitions = {
  move: { start: 'pending', active: 'moving', done: 'ready' },
  restore: { start: 'restore-pending', active: 'restoring', done: 'restored' },
  purge: { start: 'ready', active: 'purging', done: 'purged' },
};

/**
 * The caller serializes access to save(), which must commit the journal durably.
 * Moving/restoring also require offline exclusive access to the DSH session store.
 */
export async function runDiskOperation(entry, { root, trashRoot, save }, action) {
  const transition = Object.hasOwn(transitions, action) ? transitions[action] : undefined;
  if (!transition || typeof save !== 'function' || !entry || typeof entry.ticket !== 'string'
    || !ticketName.test(entry.ticket) || !Array.isArray(entry.members)
    || !entry.members.length || entry.members[0]?.id !== entry.id) fail('bad-state');
  const ids = new Set();
  for (const member of entry.members) {
    if (!member || ids.has(member.id)) fail('bad-state');
    memberParts(member.id, member.relative);
    ids.add(member.id);
  }
  if (entry.phase === transition.done) return entry;
  const retry = entry.phase === transition.active;
  if (!retry && entry.phase !== transition.start) fail('bad-state');

  absolute(root);
  absolute(trashRoot);
  if (within(root, trashRoot) || within(trashRoot, root)) fail('unsafe-path');
  const rootStat = await ensureDirectoryTree(root, false);
  const device = rootStat.dev;
  checkDevice(await ensureDirectoryTree(trashRoot, action === 'move'), device);
  const ticketDir = join(trashRoot, entry.ticket);
  let ticketStat = await checkDirectory(ticketDir);
  if (!ticketStat && action === 'move') {
    await makeDirectory(ticketDir);
    ticketStat = await checkDirectory(ticketDir);
  }
  if (ticketStat) checkDevice(ticketStat, device);
  if (ticketStat) {
    const names = await readdir(ticketDir);
    const allowed = new Set(entry.members.map(({ id }) => encodeId(id)));
    if (names.some((name) => !allowed.has(name))) fail('collision');
  }

  const allLocations = [];
  const directoryIdentities = new Set();
  for (const member of entry.members) {
    if ((retry || action !== 'move') && !member.identity) fail('bad-state');
    const found = await locations(root, ticketDir, member, device, action !== 'purge' || !retry);
    if (found.identity) {
      const key = `${found.identity.dev}:${found.identity.ino}`;
      if (directoryIdentities.has(key)) fail('collision');
      directoryIdentities.add(key);
    }
    if (action === 'move' && found.placement !== 'source' && !(retry && found.placement === 'trash')) {
      fail(found.placement === 'deleted' ? 'missing' : 'collision');
    }
    if (action === 'restore' && found.placement !== 'trash' && !(retry && found.placement === 'source')) {
      fail(found.placement === 'deleted' ? 'missing' : 'collision');
    }
    if (action === 'purge' && found.placement !== 'trash' && !(retry && found.placement === 'deleted')) {
      fail(found.placement === 'deleted' ? 'missing' : 'collision');
    }
    allLocations.push(found);
  }
  if (!retry) {
    if (action === 'move') {
      const size = allLocations.reduce((total, item) => total + item.bytes, 0);
      if (!Number.isSafeInteger(size)) fail('unsupported');
      entry.bytes = size;
      for (const [index, member] of entry.members.entries()) {
        member.bytes = allLocations[index].bytes;
        member.identity = allLocations[index].identity;
        member.disk = 'source';
      }
    }
    entry.phase = transition.active;
    await save(entry);
  }

  for (const [index, member] of entry.members.entries()) {
    const { source, trash, project, projectExists, placement } = allLocations[index];
    if (action === 'move') {
      if (placement === 'source') await moveDirectory(source, trash, member, device);
      await syncDirectory(project);
      await syncDirectory(ticketDir);
      member.disk = 'trash';
    } else if (action === 'restore') {
      if (placement === 'trash') {
        if (!projectExists) await makeDirectory(project);
        checkDevice(await checkDirectory(project), device);
        await moveDirectory(trash, source, member, device);
      }
      if (ticketStat) await syncDirectory(ticketDir);
      await syncDirectory(project);
      member.disk = 'source';
    } else {
      if (placement === 'trash') {
        if (await readStat(source)) fail('collision');
        const copy = await checkDirectory(trash);
        if (!copy) fail('missing');
        checkIdentity(member.identity, copy);
        // trash addresses generated member directories beneath a checked, private ticket.
        await rm(trash, { recursive: true });
      }
      if (ticketStat) await syncDirectory(ticketDir);
      member.disk = 'deleted';
    }
    await save(entry);
  }
  if (action !== 'move') {
    if (ticketStat) await rmdir(ticketDir);
    await syncDirectory(trashRoot);
  }
  entry.phase = transition.done;
  await save(entry);
  return entry;
}

async function moveDirectory(from, to, member, device) {
  const original = await checkDirectory(from);
  if (!original) fail('missing');
  checkIdentity(member.identity, original);
  checkDevice(await checkDirectory(dirname(to)), device);
  if (await readStat(to)) fail('collision');
  try { await rename(from, to); }
  catch (error) { if (error.code === 'EXDEV') fail('cross-device'); throw error; }
}
