import { createSessionDelete } from './delete.js';

export const inject = ['connection', 'workspaceRegistry', 'sessions', 'agents', 'sessionController', 'sessionPersistence', 'dshHomePath'];

export function apply(ctx) {
  const remove = createSessionDelete(ctx, {
    root: ctx.dshHomePath('sessions'),
    journal: ctx.dshHomePath('session-delete', 'delete-intent.json'),
    legacyTrash: ctx.dshHomePath('session-delete', 'trash.json'),
  });
  ctx.effect(() => {
    const lifetime = new AbortController();
    const startup = setImmediate(() => {
      remove.recoverPending(lifetime.signal).catch((error) => ctx.logger.warn('Session delete startup recovery: %s', error));
    });
    return () => {
      clearImmediate(startup);
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
