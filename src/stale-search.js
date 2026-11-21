import { lstatSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const nativeProvider = '@deepseek-ai/dsh-session-query-sqlite';
const nativeApplicationId = 0x44534851;
const nativeSchemaVersion = 8;

// The DSH rc.5 search schema and the native FTS5 shadow tables. Reject extra
// objects, especially triggers, before executing any DELETE against the file.
const expectedSchema = new Map([
  ['search_state', `CREATE TABLE search_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), global_generation INTEGER NOT NULL
  ) STRICT`],
  ['persisted_sessions', `CREATE TABLE persisted_sessions (
    id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at INTEGER NOT NULL, cwd TEXT,
    parent_session TEXT, seed_length INTEGER, delegation_depth INTEGER, agent_preset TEXT,
    revision TEXT NOT NULL, generation INTEGER NOT NULL
  ) STRICT`],
  ['persisted_docs', `CREATE VIRTUAL TABLE persisted_docs USING fts5(
    text, session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, time UNINDEXED,
    surface UNINDEXED, codepoint_length UNINDEXED, tokenize = 'unicode61'
  )`],
  ['persisted_docs_config', "CREATE TABLE 'persisted_docs_config'(k PRIMARY KEY, v) WITHOUT ROWID"],
  ['persisted_docs_content', "CREATE TABLE 'persisted_docs_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4, c5, c6)"],
  ['persisted_docs_data', "CREATE TABLE 'persisted_docs_data'(id INTEGER PRIMARY KEY, block BLOB)"],
  ['persisted_docs_docsize', "CREATE TABLE 'persisted_docs_docsize'(id INTEGER PRIMARY KEY, sz BLOB)"],
  ['persisted_docs_idx', "CREATE TABLE 'persisted_docs_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID"],
]);

export function configuredDisabledSearchPath(ctx, query) {
  if (query !== undefined) return query?.config?.openAt === 'never' ? query.config.path : undefined;
  const loader = ctx.get('loader');
  if (typeof loader?.entries !== 'function') return undefined;
  const matches = [...loader.entries()].filter(({ options }) => options?.name === nativeProvider);
  if (matches.length !== 1) return undefined;
  const [entry] = matches;
  if (entry.options.id !== 'session-query-sqlite' || entry.disabled !== true) return undefined;
  const path = entry.options.config?.path;
  return typeof path === 'string' ? path : undefined;
}

function lstatIfPresent(path) {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function ordinaryFile(stat) {
  return stat.isFile() && stat.nlink === 1n;
}

function safeFile(path, original) {
  const current = lstatIfPresent(path);
  if (!current || !ordinaryFile(current) || current.ino !== original.ino || current.dev !== original.dev) return false;
  if (relative(path, realpathSync(path)) !== '') return false;
  return ['-journal', '-wal', '-shm'].every((suffix) => {
    const sidecar = lstatIfPresent(path + suffix);
    return !sidecar || (ordinaryFile(sidecar) && sidecar.dev === original.dev);
  });
}

function canonicalSql(sql) {
  return sql.toLowerCase().replace(/\s+/gu, ' ').replace(/\s*([,()])\s*/gu, '$1').trim();
}

function knownSchema(db) {
  if (db.prepare('PRAGMA main.application_id').get().application_id !== nativeApplicationId
    || db.prepare('PRAGMA main.user_version').get().user_version !== nativeSchemaVersion) return false;
  const rows = db.prepare('SELECT name, type, tbl_name, sql FROM main.sqlite_schema').all();
  return rows.length === expectedSchema.size + 1 && rows.every(({ name, type, tbl_name: table, sql }) => {
    if (name === 'sqlite_autoindex_persisted_sessions_1') {
      return type === 'index' && table === 'persisted_sessions' && sql === null;
    }
    const expected = expectedSchema.get(name);
    return type === 'table' && table === name && typeof sql === 'string' && expected !== undefined
      && canonicalSql(sql) === canonicalSql(expected);
  });
}

/** Remove exactly the given sessions from the disabled native persistent index. */
export async function cleanStaleSearch(configuredPath, ids) {
  if (configuredPath === ':memory:') return true;
  if (typeof configuredPath !== 'string' || configuredPath === '' || configuredPath.includes('\0')) return false;
  const path = resolve(configuredPath);
  const original = lstatIfPresent(path);
  if (!original) return true;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch (error) { if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') return false; throw error; }

  if (!safeFile(path, original)) return false;
  const url = pathToFileURL(path);
  const probe = new DatabaseSync(`${url.href}?mode=ro`, { readOnly: true });
  try {
    probe.exec('PRAGMA trusted_schema = OFF');
    if (!safeFile(path, original) || !knownSchema(probe)) return false;
  } catch (error) {
    // Malformed or foreign data is a skipped candidate. Keep I/O errors retryable.
    if ([11, 26].includes(error.errcode & 0xff)) return false;
    throw error;
  } finally {
    probe.close();
  }

  // URI mode=rw requires an existing main file even if the path disappears
  // after the check. SQLite serializes writes with all other connections.
  if (!safeFile(path, original)) return false;
  const db = new DatabaseSync(`${url.href}?mode=rw`, { timeout: 750 });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    if (!safeFile(path, original)) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!safeFile(path, original) || !knownSchema(db)) {
        db.exec('ROLLBACK');
        return false;
      }
      const docs = db.prepare('DELETE FROM main.persisted_docs WHERE session_id = ?');
      const sessions = db.prepare('DELETE FROM main.persisted_sessions WHERE id = ?');
      let changed = false;
      for (const id of new Set(ids)) {
        const removedDocs = docs.run(id).changes;
        const removedSessions = sessions.run(id).changes;
        if (removedDocs || removedSessions) changed = true;
      }
      if (changed) {
        const state = db.prepare('UPDATE main.search_state SET global_generation = global_generation + 1 WHERE singleton = 1');
        if (state.run().changes !== 1) throw new Error('Missing DSH session search generation');
      }
      db.exec('COMMIT');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the cleanup failure. */ }
      throw error;
    }
  } finally {
    db.close();
  }
}
