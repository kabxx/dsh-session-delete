import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { directoryTree, stat } from './online-disk.js';

const domainName = 'session_projcache';
const safeKey = /^[a-zA-Z0-9_-]+$/u;
const acceptedVersions = new Set([3, 4, 5, 6, 7]);
const maxBytes = 64n * 1024n * 1024n;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCheckpoint(text) {
  let document;
  try { document = JSON.parse(text); } catch { return false; }
  if (!acceptedVersions.has(document?.version)) return false;
  const { identity, rows } = document.record ?? {};
  return isObject(identity) && Number.isSafeInteger(identity.createdAt) && identity.createdAt >= 0
    && (identity.formatVersion === undefined || (Number.isSafeInteger(identity.formatVersion) && identity.formatVersion >= 0))
    && (identity.cwd === undefined || typeof identity.cwd === 'string')
    && (identity.isSeeded === undefined || typeof identity.isSeeded === 'boolean')
    && (identity.inheritedEventCount === undefined || (Number.isSafeInteger(identity.inheritedEventCount) && identity.inheritedEventCount >= 0))
    && isObject(rows) && Object.values(rows).every((row) => isObject(row)
      && Number.isSafeInteger(row.ver) && row.ver >= 0
      && Number.isSafeInteger(row.seq) && row.seq >= -1 && Object.hasOwn(row, 'val'));
}

function sameFile(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function canUseFallback(ctx, facility, backend, root) {
  if (!(facility?.reserved instanceof Set) || facility.reserved.has(domainName)
    || facility.get(domainName) || ctx.get('storageDomain') !== facility) return false;
  const route = facility.config?.routes?.[domainName] ?? facility.config?.backend;
  return route === 'json' && backend?.constructor?.name === 'JsonStorageBackend' && backend.root === root
    && ctx.get('storage.backend.json') === backend && ctx.get('storage')?.backend?.get('json') === backend;
}

/** Reconcile only rc.5's default JSON per-record checkpoints when their domain is closed. */
export async function removeStaleProjection(ctx, ids) {
  const targets = [...new Set(ids)];
  const facility = ctx.get('storageDomain');
  const backend = ctx.get('storage.backend.json');
  const root = ctx.dshHomePath('storages');
  if (!targets.length) return { removed: 0, skipped: 0 };
  if (process.platform !== 'linux' || !canUseFallback(ctx, facility, backend, root)) {
    return { removed: 0, skipped: targets.length };
  }

  const path = join(root, domainName, 'sessions');
  let expectedDirectory;
  try { expectedDirectory = await directoryTree(path, false); }
  catch (error) {
    if (error.code === 'missing') return { removed: 0, skipped: 0 };
    if (error.code === 'unsafe-path') return { removed: 0, skipped: targets.length };
    throw error;
  }
  const table = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const result = { removed: 0, skipped: 0 };
  try {
    const directory = await table.stat({ bigint: true });
    if (directory.dev !== expectedDirectory.dev || directory.ino !== expectedDirectory.ino) {
      return { removed: 0, skipped: targets.length };
    }
    for (const id of targets) {
      if (typeof id !== 'string' || id.length > 200 || !safeKey.test(id)) {
        result.skipped++;
        continue;
      }
      const file = `/proc/self/fd/${table.fd}/${id}.json`;
      const before = await stat(file);
      if (!before) continue;
      if (!before.isFile() || before.nlink !== 1n || before.dev !== directory.dev || before.size > maxBytes) {
        result.skipped++;
        continue;
      }
      let handle;
      try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (error.code !== 'ELOOP') throw error;
        result.skipped++;
        continue;
      }
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !sameFile(opened, before)) {
          result.skipped++;
          continue;
        }
        // Read just the inspected size, so a concurrent append cannot make the read unbounded.
        const bytes = Buffer.alloc(Number(opened.size));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length || !isCheckpoint(bytes.toString('utf8'))
          || await ctx.sessionPersistence.stat(id)
          || !canUseFallback(ctx, facility, backend, root) || !sameFile(opened, await stat(file))) {
          result.skipped++;
          continue;
        }
        await unlink(file);
        await table.sync();
        result.removed++;
      } finally { await handle.close(); }
    }
    return result;
  } finally { await table.close(); }
}
