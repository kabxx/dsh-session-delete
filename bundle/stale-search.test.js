import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { cleanStaleSearch, configuredDisabledSearchPath } from './stale-search.js';

const ids = ['main', "child' OR 1=1 --", 'MAIN', 'main-other'];

function testDirectory() {
  return mkdtempSync(join(tmpdir(), 'dsh-delete-search-test-'));
}

function fixture(path, extras = '') {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA application_id = 0x44534851;
      PRAGMA user_version = 8;
      CREATE TABLE IF NOT EXISTS search_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        global_generation INTEGER NOT NULL
      ) STRICT;
      INSERT INTO search_state VALUES (1, 7);
      CREATE TABLE IF NOT EXISTS persisted_sessions (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at INTEGER NOT NULL, cwd TEXT,
        parent_session TEXT, seed_length INTEGER, delegation_depth INTEGER, agent_preset TEXT,
        revision TEXT NOT NULL, generation INTEGER NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(
        text, session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, time UNINDEXED,
        surface UNINDEXED, codepoint_length UNINDEXED, tokenize = 'unicode61'
      );
      ${extras}
    `);
    const session = db.prepare('INSERT INTO persisted_sessions (id, version, created_at, revision, generation) VALUES (?, 4, 1, ?, 2)');
    const docs = db.prepare('INSERT INTO persisted_docs (session_id, text, seq) VALUES (?, ?, ?)');
    for (const id of ids) {
      session.run(id, id);
      docs.run(id, 'needle one', 0);
      docs.run(id, 'needle two', 1);
    }
  } finally {
    db.close();
  }
}

function readSearch(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      sessions: db.prepare('SELECT id FROM persisted_sessions ORDER BY id').all().map(({ id }) => id),
      docs: db.prepare("SELECT session_id FROM persisted_docs WHERE persisted_docs MATCH 'needle' ORDER BY session_id")
        .all().map(({ session_id }) => session_id),
      generation: db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1').get().global_generation,
    };
  } finally {
    db.close();
  }
}

test('removes exact native SQLite and FTS rows without touching similarly named sessions', async () => {
  const path = join(testDirectory(), 'index ? # %.sqlite');
  fixture(path);
  const inode = statSync(path).ino;
  const expected = { sessions: ['MAIN', 'main-other'], docs: ['MAIN', 'MAIN', 'main-other', 'main-other'], generation: 8 };
  assert.equal(await cleanStaleSearch(path, ids.slice(0, 2)), true);
  assert.equal(statSync(path).ino, inode);
  assert.deepEqual(readSearch(path), expected);
  assert.equal(await cleanStaleSearch(path, ids.slice(0, 2)), true);
  assert.deepEqual(readSearch(path), expected);
});

test('does not create a missing index or operate on symbolic links', async () => {
  const dir = testDirectory();
  const missing = join(dir, 'missing.sqlite');
  assert.equal(await cleanStaleSearch(':memory:', ids), true);
  assert.equal(await cleanStaleSearch(missing, ids), true);
  assert.throws(() => statSync(missing), { code: 'ENOENT' });
  const original = join(dir, 'native.sqlite');
  const link = join(dir, 'link.sqlite');
  fixture(original);
  symlinkSync(original, link);
  const before = readSearch(original);
  assert.equal(await cleanStaleSearch(link, ids), false);
  assert.deepEqual(readSearch(original), before);
  const external = join(dir, 'unrelated');
  writeFileSync(external, 'precious content');
  symlinkSync(external, original + '-journal');
  assert.equal(await cleanStaleSearch(original, ids), false);
  assert.equal(readFileSync(external, 'utf8'), 'precious content');
});

test('rejects other application IDs, unsupported versions, extra objects and invalid SQLite', async () => {
  const dir = testDirectory();
  const cases = [
    ['other-app', 'PRAGMA application_id = 19'],
    ['future-version', 'PRAGMA user_version = 9'],
    ['trigger', `CREATE TRIGGER unrelated AFTER DELETE ON persisted_sessions BEGIN
      DELETE FROM persisted_sessions WHERE id = 'main-other'; END`],
    ['extra-table', 'CREATE TABLE user_data (payload TEXT)'],
  ];
  for (const [name, sql] of cases) {
    const path = join(dir, `${name}.sqlite`);
    fixture(path, sql);
    const before = readFileSync(path);
    assert.equal(await cleanStaleSearch(path, ids), false);
    assert.deepEqual(readFileSync(path), before);
  }
  const invalid = join(dir, 'not-sqlite');
  writeFileSync(invalid, 'precious content');
  assert.equal(await cleanStaleSearch(invalid, ids), false);
  assert.equal(readFileSync(invalid, 'utf8'), 'precious content');
});

test('active SQLite writer leaves every target row unchanged and allows a retry', async () => {
  const path = join(testDirectory(), 'index.sqlite');
  fixture(path);
  const before = readSearch(path);
  const writer = new DatabaseSync(path);
  try {
    writer.exec('BEGIN IMMEDIATE');
    await assert.rejects(() => cleanStaleSearch(path, ids), { errcode: 5 });
    assert.deepEqual(readSearch(path), before);
    writer.exec('ROLLBACK');
  } finally {
    writer.close();
  }
  assert.equal(await cleanStaleSearch(path, ids), true);
  assert.deepEqual(readSearch(path), { sessions: [], docs: [], generation: 8 });
});

test('recovers only a unique literal configured path when the native service is hard-disabled', () => {
  const spec = { id: 'session-query-sqlite', name: '@deepseek-ai/dsh-session-query-sqlite' };
  const entry = { disabled: true, options: { ...spec, config: { path: '/known native.sqlite' } } };
  const ctx = (...entries) => ({ get: () => ({ entries: () => entries }) });
  assert.equal(configuredDisabledSearchPath(ctx(entry)), '/known native.sqlite');
  assert.equal(configuredDisabledSearchPath(ctx(entry), { config: { openAt: 'never', path: ':memory:' } }), ':memory:');
  assert.equal(configuredDisabledSearchPath(ctx(entry), { config: { openAt: 'startup', path: '/active.sqlite' } }), undefined);
  assert.equal(configuredDisabledSearchPath(ctx(entry, entry)), undefined);
  assert.equal(configuredDisabledSearchPath(ctx({ ...entry, disabled: false })), undefined);
  assert.equal(configuredDisabledSearchPath(ctx({ ...entry, options: { ...spec, config: { path: { __jsExpr: 'customPath()' } } } })), undefined);
});
