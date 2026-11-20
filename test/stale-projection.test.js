import assert from 'node:assert/strict';
import { access, link, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { removeStaleProjection } from '../src/stale-projection.js';

class JsonStorageBackend {
  constructor(root) { this.root = root; }
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-stale-projection-'));
  t.after(async () => {
    assert.equal(dirname(home), tmpdir());
    await rm(home, { recursive: true });
  });
  const root = join(home, 'storages');
  const profileTable = join(root, 'session_projcache', 'sessions');
  await mkdir(profileTable, { recursive: true });
  const facility = { config: { backend: 'json', routes: {} }, reserved: new Set(), get() {} };
  const backend = new JsonStorageBackend(root);
  const persistence = new Set();
  const services = {
    storageDomain: facility,
    'storage.backend.json': backend,
    storage: { backend: { get: (name) => name === 'json' ? backend : undefined } },
  };
  const ctx = {
    get: (key) => services[key], dshHomePath: (...parts) => join(home, ...parts),
    sessionPersistence: { stat: async (id) => persistence.has(id) ? { header: { id } } : undefined },
  };
  const record = (id, version = 7) => JSON.stringify({ version, record: {
    identity: { formatVersion: 4, createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
    rows: { title: { ver: 1, seq: 0, val: id } },
  } });
  const file = (id) => join(profileTable, `${id}.json`);
  const seed = (id, version) => writeFile(file(id), record(id, version));
  return { home, root, profileTable, facility, backend, persistence, ctx, record, file, seed };
}

const linux = { skip: process.platform !== 'linux' };

test('removes only exact native parent and child checkpoints while the domain is closed', linux, async (t) => {
  const { ctx, file, seed, record, root } = await fixture(t);
  await Promise.all([seed('parent'), seed('child', 3), seed('child-extra')]);
  const legacy = join(root, 'session_projcache.json');
  await writeFile(legacy, '{"unrelated":true}');
  assert.deepEqual(await removeStaleProjection(ctx, ['parent', 'child', 'parent', 'missing']), { removed: 2, skipped: 0 });
  await assert.rejects(access(file('parent')), { code: 'ENOENT' });
  await assert.rejects(access(file('child')), { code: 'ENOENT' });
  assert.equal(await readFile(file('child-extra'), 'utf8'), record('child-extra'));
  assert.equal(await readFile(legacy, 'utf8'), '{"unrelated":true}');
});

test('leaves unknown formats and unsafe file identities intact', linux, async (t) => {
  const { ctx, home, file, seed, persistence, record } = await fixture(t);
  const outside = join(home, 'unrelated.json');
  await writeFile(outside, record('unrelated'));
  await symlink(outside, file('symlink'));
  await link(outside, file('hardlink'));
  await seed('future', 999);
  await seed('existing');
  persistence.add('existing');
  await writeFile(file('wrong-shape'), '{"version":7,"record":{"unrelated":true}}');
  const targets = ['symlink', 'hardlink', 'future', 'existing', 'wrong-shape', '../../unrelated'];
  assert.deepEqual(await removeStaleProjection(ctx, targets), { removed: 0, skipped: targets.length });
  for (const id of targets.slice(0, -1)) await access(file(id));
  assert.equal(await readFile(outside, 'utf8'), record('unrelated'));
});

test('skips routed storage, a custom root, an opening domain, and a mounted domain', linux, async (t) => {
  const { ctx, facility, backend, home, root, file, seed } = await fixture(t);
  await seed('target');
  const skipped = { removed: 0, skipped: 1 };
  facility.config.routes.session_projcache = 'sqlite';
  assert.deepEqual(await removeStaleProjection(ctx, ['target']), skipped);
  delete facility.config.routes.session_projcache;
  backend.root = home;
  assert.deepEqual(await removeStaleProjection(ctx, ['target']), skipped);
  backend.root = root;
  facility.reserved.add('session_projcache');
  assert.deepEqual(await removeStaleProjection(ctx, ['target']), skipped);
  facility.reserved.clear();
  facility.get = () => ({ table() {} });
  assert.deepEqual(await removeStaleProjection(ctx, ['target']), skipped);
  await access(file('target'));
});

test('refuses to follow a symlink in the table directory path', linux, async (t) => {
  const { ctx, profileTable, home, record } = await fixture(t);
  const outside = join(home, 'unrelated-table');
  await mkdir(outside);
  const unrelated = join(outside, 'target.json');
  await writeFile(unrelated, record('unrelated'));
  await rmdir(profileTable);
  await symlink(outside, profileTable);
  assert.deepEqual(await removeStaleProjection(ctx, ['target']), { removed: 0, skipped: 1 });
  assert.equal(await readFile(unrelated, 'utf8'), record('unrelated'));
});
