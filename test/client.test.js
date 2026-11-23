import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js');
const clientSource = readFileSync(clientPath, 'utf8');

function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (next) => {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness({ fetchImpl, listedSessions = ['a', 'a-child', 'b'] } = {}) {
  let loaded;
  const timers = new Set();
  const sandbox = {
    window: { __ModuleLoader__: { load(entry) { loaded = entry; } } },
    document: { body: { nodeName: 'BODY' } },
    fetch: fetchImpl,
    AbortController,
    setTimeout: (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
      clearTimeout(id);
    },
    console,
  };
  vm.runInNewContext(clientSource, sandbox, { filename: clientPath });

  const Fragment = Symbol('Fragment');
  const Button = Symbol('Button');
  const Modal = Symbol('Modal');
  const StateDot = Symbol('StateDot');
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const createPortal = (children, container) => ({ portal: true, children, container });

  const plugin = loaded.factory((specifier) => {
    if (specifier === 'react') {
      return {
        Fragment,
        createElement,
        useId: () => 'desc-id',
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
      };
    }
    if (specifier === 'react-dom') return { createPortal };
    if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: createStore };
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Button, Modal, StateDot };
    throw new Error(`unexpected require: ${specifier}`);
  });

  const blockStores = new Map();
  const blocks = {
    storeFor(id) {
      let store = blockStores.get(id);
      if (!store) {
        store = createStore(undefined);
        blockStores.set(id, store);
      }
      return store;
    },
    set(id, block) {
      const store = this.storeFor(id);
      if (store.getSnapshot()?.reason === block?.reason) return;
      store.set(block);
    },
  };

  const sessionMap = Object.fromEntries(listedSessions.map((id) => [id, { id }]));
  const sessionList = createStore({ byId: sessionMap });
  const removedFlags = new Map();
  let refreshCount = 0;
  const sessions = {
    list: sessionList,
    get refreshCount() { return refreshCount; },
    async refresh() {
      refreshCount += 1;
    },
    binding(id) {
      return { session: { getSnapshot: () => ({ removed: removedFlags.get(id) === true }) } };
    },
    markRemoved(id) {
      removedFlags.set(id, true);
      const next = { ...sessionList.getSnapshot().byId };
      delete next[id];
      sessionList.set({ byId: next });
    },
  };

  let registeredMenu;
  const overlays = new Map();
  const cleanups = [];
  let dictionaries = {};
  const translate = (key, values = {}) => {
    let text = dictionaries.zh?.[key] ?? key;
    for (const [name, value] of Object.entries(values)) text = text.replace(`{${name}}`, String(value));
    return text;
  };

  const localeStore = createStore('zh');
  const workspaceList = createStore({ archivedSessionIds: [] });
  const accessStore = createStore(true);
  const ctx = {
    contextMenus: {
      register(contribution) {
        registeredMenu = contribution;
        return () => {};
      },
    },
    locale: {
      ...localeStore,
      bind: () => translate,
      register: (_ns, strings) => {
        dictionaries = strings;
        return () => {};
      },
    },
    workspaces: { list: workspaceList },
    remoteAccess: { source: () => accessStore },
    slots: {
      inject: (_name, fn) => fn(),
      register: (meta, component) => {
        overlays.set(meta.id, component);
        return () => { overlays.delete(meta.id); };
      },
    },
    get(service) {
      if (service === 'conversation') return { blocks };
      if (service === 'sessions') return sessions;
      return undefined;
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };

  plugin.apply(ctx);

  const renderDialog = () => overlays.get('session-delete.confirm')({ t: translate });
  const renderToast = () => {
    let factoryCall = null;
    const tree = overlays.get('session-delete.toast')({
      t: translate,
      renderFactorySlot(slot, props) {
        factoryCall = { slot, props };
        return { factory: slot, props };
      },
    });
    return { tree, factoryCall };
  };
  const resolveMenu = (target) => registeredMenu.resolve(target);
  const observeMenu = (target, onChange) => {
    const offs = registeredMenu.observe(target).map((store) => store.subscribe(onChange));
    return () => { for (const off of offs) off(); };
  };
  const findButtons = (node, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (node.type === Button) out.push(node);
    if (node.props?.footer) findButtons(node.props.footer, out);
    for (const child of node.children ?? []) findButtons(child, out);
    return out;
  };
  const dispose = () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };

  return {
    blocks,
    sessions,
    timers,
    StateDot,
    renderDialog,
    renderToast,
    resolveMenu,
    observeMenu,
    findButtons,
    dispose,
  };
}

test('menu disables delete reactively across preview, confirmation, and in-flight deletion', async () => {
  const previewGate = createDeferred();
  const deleteGate = createDeferred();
  const calls = [];
  const harness = createHarness({
    fetchImpl: (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === 'preview') return previewGate.promise;
      return deleteGate.promise;
    },
  });

  const targetA = { sessionId: 'a', displayTitle: 'Session A' };
  const targetB = { sessionId: 'b', displayTitle: 'Session B' };
  let updates = 0;
  const unobserve = harness.observeMenu(targetB, () => { updates += 1; });

  assert.equal(harness.resolveMenu(targetB)[0].disabled, undefined);

  const previewing = harness.resolveMenu(targetA)[0].run();
  assert.equal(harness.resolveMenu(targetB)[0].disabled, true);
  assert.ok(updates > 0);

  previewGate.resolve({
    ok: true,
    json: async () => ({ ticket: 't1', count: 1, memberIds: ['a', 'a-child'] }),
  });
  await previewing;

  assert.equal(harness.resolveMenu(targetB)[0].disabled, true);
  const dialog = harness.renderDialog();
  assert.ok(dialog);
  const buttons = harness.findButtons(dialog);
  const confirmButton = buttons.find((button) => button.props.className === 'dsh-session-delete-confirm-action');

  const deleting = confirmButton.props.onClick();
  assert.equal(harness.renderDialog(), null);
  assert.equal(harness.resolveMenu(targetB)[0].disabled, true);

  const pendingToast = harness.renderToast();
  const portal = pendingToast.tree.children[1];
  assert.equal(portal.portal, true);
  assert.equal(portal.children.children[0].props.className, 'dsh-session-delete-progress');
  assert.equal(portal.children.children[0].children[0].type, harness.StateDot);

  deleteGate.resolve({ ok: true, json: async () => ({ deleted: true }) });
  harness.sessions.markRemoved('a');
  harness.sessions.markRemoved('a-child');
  await deleting;

  assert.equal(harness.resolveMenu(targetB)[0].disabled, undefined);
  assert.equal(harness.renderToast().factoryCall.props.tone, 'success');
  assert.equal(calls.length, 2);

  unobserve();
  harness.dispose();
});

test('confirm locks target and child composers before closing modal and releases cleanly on removal or failure', async () => {
  const deleteGate = createDeferred();
  let mode = 'success';
  const harness = createHarness({
    fetchImpl: (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'preview') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ticket: 't2', count: 1, memberIds: ['a', 'a-child'] }),
        });
      }
      if (mode === 'success') return deleteGate.promise;
      return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'locked' }) });
    },
  });

  // Pre-existing block on an unrelated session or target must never be clobbered.
  const externalBlock = { reason: 'Other plugin block' };
  harness.blocks.set('a-child', externalBlock);

  await harness.resolveMenu({ sessionId: 'a', displayTitle: 'Session A' })[0].run();
  assert.equal(harness.blocks.storeFor('a').getSnapshot(), undefined);

  const confirmButton = harness.findButtons(harness.renderDialog())
    .find((button) => button.props.className === 'dsh-session-delete-confirm-action');
  let lockedWhenDialogClosed = false;
  let disabledWhenDialogClosed = false;
  const unobserveDialog = harness.observeMenu({ sessionId: 'b', displayTitle: 'Session B' }, () => {
    if (harness.renderDialog() === null) {
      lockedWhenDialogClosed = harness.blocks.storeFor('a').getSnapshot()?.reason === '正在删除…';
      disabledWhenDialogClosed = harness.resolveMenu({ sessionId: 'b', displayTitle: 'Session B' })[0].disabled === true;
    }
  });
  const deleting = confirmButton.props.onClick();
  unobserveDialog();

  assert.equal(harness.renderDialog(), null);
  assert.equal(lockedWhenDialogClosed, true);
  assert.equal(disabledWhenDialogClosed, true);
  assert.equal(harness.blocks.storeFor('a').getSnapshot()?.reason, '正在删除…');
  assert.equal(harness.blocks.storeFor('a-child').getSnapshot(), externalBlock);
  assert.equal(harness.blocks.storeFor('b').getSnapshot(), undefined);

  deleteGate.resolve({ ok: true, json: async () => ({ deleted: true }) });
  await deleting;

  // Still held until api-session/removed clears the session from sessions.list.
  assert.equal(harness.blocks.storeFor('a').getSnapshot()?.reason, '正在删除…');
  assert.equal(harness.timers.size, 1);

  harness.sessions.markRemoved('a');
  assert.equal(harness.blocks.storeFor('a').getSnapshot(), undefined);
  assert.equal(harness.blocks.storeFor('a-child').getSnapshot(), externalBlock);
  assert.equal(harness.timers.size, 0);

  // Failure unlocks immediately so the user keeps editing their draft.
  mode = 'failure';
  await harness.resolveMenu({ sessionId: 'b', displayTitle: 'Session B' })[0].run();
  const confirmB = harness.findButtons(harness.renderDialog())
    .find((button) => button.props.className === 'dsh-session-delete-confirm-action');
  await confirmB.props.onClick();

  assert.equal(harness.blocks.storeFor('b').getSnapshot(), undefined);
  assert.equal(harness.renderToast().factoryCall.props.tone, 'warning');
  assert.equal(harness.timers.size, 0);

  // Cancel re-enables the menu item without locking the composer.
  await harness.resolveMenu({ sessionId: 'b', displayTitle: 'Session B' })[0].run();
  assert.equal(harness.resolveMenu({ sessionId: 'b', displayTitle: 'Session B' })[0].disabled, true);
  const cancelB = harness.findButtons(harness.renderDialog())
    .find((button) => button.props.variant === 'outline');
  cancelB.props.onClick();
  assert.equal(harness.renderDialog(), null);
  assert.equal(harness.blocks.storeFor('b').getSnapshot(), undefined);
  assert.equal(harness.resolveMenu({ sessionId: 'b', displayTitle: 'Session B' })[0].disabled, undefined);

  harness.dispose();
});

test('disposing mid-delete aborts request and clears composer blocks and busy state', async () => {
  let aborted = false;
  const harness = createHarness({
    fetchImpl: (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'preview') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ticket: 't3', count: 1, memberIds: ['a', 'a-child'] }),
        });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    },
  });

  await harness.resolveMenu({ sessionId: 'a', displayTitle: 'Session A' })[0].run();
  const confirmButton = harness.findButtons(harness.renderDialog())
    .find((button) => button.props.className === 'dsh-session-delete-confirm-action');
  const deleting = confirmButton.props.onClick();

  assert.equal(harness.blocks.storeFor('a').getSnapshot()?.reason, '正在删除…');
  assert.equal(harness.blocks.storeFor('a-child').getSnapshot()?.reason, '正在删除…');

  harness.dispose();
  await deleting;

  assert.equal(aborted, true);
  assert.equal(harness.blocks.storeFor('a').getSnapshot(), undefined);
  assert.equal(harness.blocks.storeFor('a-child').getSnapshot(), undefined);
  assert.equal(harness.resolveMenu({ sessionId: 'b', displayTitle: 'Session B' })[0].disabled, undefined);
  assert.equal(harness.timers.size, 0);
});

test('delete transport errors report unconfirmed outcome and refresh list while preview errors stay failed', async () => {
  let deleteMode = 'network';
  let previewFails = false;
  const harness = createHarness({
    fetchImpl: (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'preview') {
        if (previewFails) return Promise.reject(new TypeError('network down'));
        return Promise.resolve({
          ok: true,
          json: async () => ({ ticket: 't4', count: 0, memberIds: [body.id] }),
        });
      }
      if (deleteMode === 'network') return Promise.reject(new TypeError('connection reset'));
      if (deleteMode === 'truncated') {
        return Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('EOF'); } });
      }
      if (deleteMode === 'cross-device') {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'cross-device' }) });
      }
      if (deleteMode === 'collision') {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'collision' }) });
      }
      return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'restored' }) });
    },
  });

  // Preview network failure stays generic failed and does not call refresh.
  previewFails = true;
  await harness.resolveMenu({ sessionId: 'a', displayTitle: 'Session A' })[0].run();
  assert.equal(harness.renderToast().factoryCall.props.text, '删除失败，请重试。');
  assert.equal(harness.sessions.refreshCount, 0);
  previewFails = false;

  const triggerDelete = async () => {
    await harness.resolveMenu({ sessionId: 'a', displayTitle: 'Session A' })[0].run();
    const confirmButton = harness.findButtons(harness.renderDialog())
      .find((button) => button.props.className === 'dsh-session-delete-confirm-action');
    await confirmButton.props.onClick();
  };

  deleteMode = 'network';
  await triggerDelete();
  assert.equal(harness.renderToast().factoryCall.props.text, '未能确认删除结果，请刷新会话列表核对。');
  assert.equal(harness.sessions.refreshCount, 1);

  deleteMode = 'truncated';
  await triggerDelete();
  assert.equal(harness.renderToast().factoryCall.props.text, '未能确认删除结果，请刷新会话列表核对。');
  assert.equal(harness.sessions.refreshCount, 2);

  deleteMode = 'cross-device';
  await triggerDelete();
  assert.equal(harness.renderToast().factoryCall.props.text, '会话目录与插件暂存目录不在同一磁盘，无法安全删除。');
  assert.equal(harness.sessions.refreshCount, 3);

  deleteMode = 'collision';
  await triggerDelete();
  assert.equal(harness.renderToast().factoryCall.props.text, '会话目录状态冲突，请重试或检查目录。');
  assert.equal(harness.sessions.refreshCount, 4);

  deleteMode = 'restored';
  await triggerDelete();
  assert.equal(harness.renderToast().factoryCall.props.text, '删除失败，原会话已恢复。');
  assert.equal(harness.sessions.refreshCount, 5);

  harness.dispose();
});

test('uses a document-relative API route so subpath deployments keep their prefix', async () => {
  const urls = [];
  const harness = createHarness({
    fetchImpl: (url, init) => {
      urls.push(url);
      const body = JSON.parse(init.body);
      if (body.action === 'preview') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ticket: 't-subpath', count: 0, memberIds: [body.id] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ deleted: true }) });
    },
  });

  await harness.resolveMenu({ sessionId: 'a', displayTitle: 'Session A' })[0].run();
  const confirmButton = harness.findButtons(harness.renderDialog())
    .find((button) => button.props.className === 'dsh-session-delete-confirm-action');
  await confirmButton.props.onClick();

  assert.deepEqual(urls, ['api/session-delete/session', 'api/session-delete/session']);
  assert.equal(
    new URL(urls[0], 'https://dsh.example/ui/').href,
    'https://dsh.example/ui/api/session-delete/session',
  );
  harness.dispose();
});
