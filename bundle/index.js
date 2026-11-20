import { createSessionDelete } from './delete.js';

export const inject = ['connection', 'workspaceRegistry', 'sessions', 'agents', 'sessionController', 'sessionPersistence', 'dshHomePath'];

export function apply(ctx) {
  const remove = createSessionDelete(ctx, {
    root: ctx.dshHomePath('sessions'),
    journal: ctx.dshHomePath('session-delete', 'delete-intent.json'),
    legacyTrash: ctx.dshHomePath('session-delete', 'trash.json'),
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/session-delete/session',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: remove,
  }));
}
