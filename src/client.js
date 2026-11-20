window.__ModuleLoader__.load({
  id: '@kabxx/dsh-session-delete',
  factory(require) {
    const { Fragment, createElement: h, useId, useSyncExternalStore } = require('react');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
    const { Button, Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
    const namespace = 'sessionDelete';
    const strings = {
      zh: {
        remove: '删除会话', confirm: '永久删除', title: '永久删除此会话？', cancel: '取消', close: '关闭',
        pending: '正在删除…', untitled: '未命名会话',
        scope: '将永久删除“{title}”，删除后无法恢复。',
        scopeWithChild: '将永久删除“{title}”及其 {count} 个子智能体会话，删除后无法恢复。',
        scopeWithChildren: '将永久删除“{title}”及其 {count} 个子智能体会话，删除后无法恢复。',
        deleted: '会话已删除', cleanupPending: '会话已删除，部分索引记录待清理。',
        busy: '会话运行中，请先停止。', locked: '会话正被占用，暂时无法删除。',
        missing: '未找到该会话。', changed: '会话状态已变更，请重试。',
        unsupported: '当前存储方式不支持删除会话。', 'unsafe-path': '会话文件路径异常。',
        'dependent-fork': '仍有未迁移的分叉会话依赖此记录，暂无法删除。',
        'authentication-required': '请先完成登录认证。', failed: '删除失败，请重试。',
      },
      en: {
        remove: 'Delete session', confirm: 'Delete permanently', title: 'Permanently delete this session?', cancel: 'Cancel', close: 'Close',
        pending: 'Deleting…', untitled: 'Untitled session',
        scope: '“{title}” will be permanently deleted. This cannot be undone.',
        scopeWithChild: '“{title}” and its {count} subagent session will be permanently deleted. This cannot be undone.',
        scopeWithChildren: '“{title}” and its {count} subagent sessions will be permanently deleted. This cannot be undone.',
        deleted: 'Session deleted', cleanupPending: 'Session deleted; some index records remain.',
        busy: 'Session is running. Stop it first.', locked: 'Session is in use and cannot be deleted right now.',
        missing: 'Session not found.', changed: 'Session state changed. Try again.',
        unsupported: 'Session deletion is not supported for this storage.', 'unsafe-path': 'Invalid session file path.',
        'dependent-fork': 'An unmigrated fork still depends on this session.',
        'authentication-required': 'Sign in required.', failed: 'Failed to delete session.',
      },
    };
    const errors = new Set([
      'busy', 'locked', 'missing', 'changed', 'unsupported', 'unsafe-path', 'dependent-fork', 'authentication-required',
    ]);
    const dangerColor = 'var(--dsw-alias-state-error-primary)';
    const danger = { color: dangerColor };

    return {
      inject: ['contextMenus', 'locale', 'slots', 'workspaces', 'remoteAccess'],
      apply(ctx) {
        const menus = ctx.contextMenus;
        const t = ctx.locale.bind(namespace);
        const dialog = createSnapshotStore(null);
        const toast = createSnapshotStore(null);
        const lifetime = new AbortController();
        let checking = false;
        let toastSequence = 0;

        function notify(key, tone = 'warning') {
          toast.set({ key, tone, seq: ++toastSequence });
        }

        async function request(body) {
          const response = await fetch('/api/session-delete/session', {
            method: 'POST', credentials: 'same-origin', signal: lifetime.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok || !result || result.error) {
            const accessDenied = response.status === 401 || response.status === 403;
            throw new Error(result?.error ?? (accessDenied ? 'authentication-required' : 'failed'));
          }
          return result;
        }

        function notifyError(error) {
          if (!lifetime.signal.aborted) notify(errors.has(error.message) ? error.message : 'failed');
        }

        async function preview({ sessionId, displayTitle }) {
          if (checking || dialog.getSnapshot() !== null) return;
          checking = true;
          try {
            const { ticket, count } = await request({ action: 'preview', id: sessionId });
            if (lifetime.signal.aborted) return;
            if (typeof ticket !== 'string' || !ticket || !Number.isSafeInteger(count) || count < 0) throw new Error('failed');
            dialog.set({ sessionId, title: displayTitle?.trim(), ticket, count, pending: false });
          } catch (error) {
            notifyError(error);
          } finally {
            checking = false;
          }
        }

        function dismiss() {
          if (!dialog.getSnapshot()?.pending) dialog.set(null);
        }

        async function confirm() {
          const current = dialog.getSnapshot();
          if (!current || current.pending) return;
          dialog.set({ ...current, pending: true });
          try {
            const result = await request({ action: 'delete', id: current.sessionId, ticket: current.ticket });
            if (lifetime.signal.aborted) return;
            if (result.deleted !== true) throw new Error('failed');
            if (result.cleanupPending) notify('cleanupPending');
            else notify('deleted', 'success');
          } catch (error) {
            notifyError(error);
          } finally {
            dialog.set(null);
          }
        }

        function DeleteToast({ t, renderFactorySlot }) {
          const current = useSyncExternalStore(toast.subscribe, toast.getSnapshot);
          if (!current) return null;
          return renderFactorySlot('workspace.toast.content', {
            seq: current.seq,
            text: t(current.key),
            tone: current.tone,
            onDone: () => {
              if (toast.getSnapshot() === current) toast.set(null);
            },
          });
        }

        function DeleteDialog({ t }) {
          const current = useSyncExternalStore(dialog.subscribe, dialog.getSnapshot);
          const descriptionId = useId();
          if (!current) return null;
          const { title, count, pending } = current;
          const message = count === 0 ? 'scope' : count === 1 ? 'scopeWithChild' : 'scopeWithChildren';
          const description = t(message, { title: title || t('untitled'), count });
          return h(Fragment, null,
            // DSH Modal only exposes a warning tone. Recolor its native icon for this dialog.
            h('style', null, `.dsh-session-delete-confirm h2 > svg[aria-hidden="true"] { color: ${dangerColor}; }`),
            h(Modal, {
              open: true, className: 'dsh-session-delete-confirm', tone: 'warning',
              title: t('title'), description, closeLabel: t('close'), onClose: dismiss,
              footer: h(Fragment, null,
                h('span', { id: descriptionId, hidden: true }, description),
                h(Button, { variant: 'outline', 'data-modal-autofocus': true, 'aria-describedby': descriptionId,
                  disabled: pending, onClick: dismiss }, t('cancel')),
                h(Button, { variant: 'outline', style: pending ? undefined : danger, disabled: pending,
                  'aria-describedby': descriptionId, onClick: confirm }, t('confirm'))),
            }, pending ? h('span', { role: 'status' }, t('pending')) : undefined));
        }

        const archiveAccess = ({ sessionId }) => ctx.remoteAccess.source('session', sessionId, 'workspace/archiveSession');
        const unarchiveAccess = ({ sessionId }) => ctx.remoteAccess.source('session', sessionId, 'workspace/unarchiveSession');
        ctx.effect(() => () => lifetime.abort());
        ctx.effect(() => ctx.locale.register(namespace, strings));
        ctx.effect(() => menus.register({
          id: 'session.delete-permanently', target: 'session', order: 601,
          observe: (target) => [ctx.locale, ctx.workspaces.list, archiveAccess(target), unarchiveAccess(target)],
          resolve: (target) => {
            const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(target.sessionId);
            const access = archived ? unarchiveAccess(target) : archiveAccess(target);
            return access.getSnapshot() ? [{
              id: 'delete', label: t('remove'), icon: { key: 'workspace.delete' }, danger: true, afterContent: true,
              run: () => preview(target),
            }] : [];
          },
        }));
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'session-delete.confirm', locale: namespace,
        }, DeleteDialog)));
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'session-delete.toast', locale: namespace,
        }, DeleteToast)));
      },
    };
  },
});
