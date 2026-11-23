import { createRecoveryLoop, createSessionDelete } from './delete.js';

export const inject = ['connection', 'workspaceRegistry', 'sessions', 'agents', 'sessionController', 'sessionPersistence', 'dshHomePath'];

export function apply(ctx) {
  const lifetime = new AbortController();
  let recovery;
  const remove = createSessionDelete(ctx, {
    root: ctx.dshHomePath('sessions'),
    journal: ctx.dshHomePath('plugins', '@kabxx', 'dsh-session-delete', 'delete-intent.json'),
    legacyJournal: ctx.dshHomePath('session-delete', 'delete-intent.json'),
    legacyTrash: ctx.dshHomePath('session-delete', 'trash.json'),
    onPending: () => recovery?.notifyPending(),
  });
  recovery = createRecoveryLoop(remove.recoverPending, {
    signal: lifetime.signal,
    onError: (error) => ctx.logger.warn('Session delete startup recovery: %s', error),
  });
  ctx.effect(() => {
    recovery.triggerNow();
    const offDisposed = ctx.on('session/disposed', () => recovery.notifySessionDisposed());
    return () => {
      offDisposed();
      recovery.dispose();
      lifetime.abort();
    };
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/session-delete/session',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: remove,
  }));
}
