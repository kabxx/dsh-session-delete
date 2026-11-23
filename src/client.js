window.__ModuleLoader__.load({
  id: '@kabxx/dsh-session-delete',
  factory(require) {
    const { Fragment, createElement: h, useId, useSyncExternalStore } = require('react');
    const { createPortal } = require('react-dom');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
    const { Button, Modal, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives');
    const namespace = 'sessionDelete';
    const strings = {
      zh: {
        remove: '删除会话', confirm: '永久删除', title: '永久删除此会话？', cancel: '取消', close: '关闭',
        pending: '正在删除…', untitled: '未命名会话',
        scope: '将永久删除“{title}”，删除后无法恢复。',
        scopeWithChild: '将永久删除“{title}”及其 {count} 个子智能体会话，删除后无法恢复。',
        scopeWithChildren: '将永久删除“{title}”及其 {count} 个子智能体会话，删除后无法恢复。',
        deleted: '会话已删除', cleanupPending: '会话已删除，部分关联记录待清理。',
        restored: '删除失败，原会话已恢复。', 'restore-pending': '删除中断，会话待自动恢复，请稍后重试。',
        'recovery-pending': '删除结果待确认，稍后将自动恢复或完成清理。',
        'cleanup-pending': '上次删除仍在清理中，请稍后重试。',
        busy: '会话运行中，请先停止。', locked: '会话正被占用，暂时无法删除。',
        missing: '未找到该会话。', changed: '会话状态已变更，请重试。',
        unsupported: '当前存储方式不支持删除会话。', 'unsafe-path': '会话文件路径异常。',
        'cross-device': '会话目录与插件暂存目录不在同一磁盘，无法安全删除。',
        collision: '会话目录状态冲突，请重试或检查目录。',
        'dependent-fork': '仍有未迁移的分叉会话依赖此记录，暂时无法删除。',
        'authentication-required': '请先完成登录认证。',
        unconfirmed: '未能确认删除结果，请刷新会话列表核对。',
        failed: '删除失败，请重试。',
      },
      en: {
        remove: 'Delete session', confirm: 'Delete permanently', title: 'Permanently delete this session?', cancel: 'Cancel', close: 'Close',
        pending: 'Deleting…', untitled: 'Untitled session',
        scope: '“{title}” will be permanently deleted. This cannot be undone.',
        scopeWithChild: '“{title}” and its {count} subagent session will be permanently deleted. This cannot be undone.',
        scopeWithChildren: '“{title}” and its {count} subagent sessions will be permanently deleted. This cannot be undone.',
        deleted: 'Session deleted', cleanupPending: 'Session deleted; some associated records remain.',
        restored: 'Failed to delete session. Original session was restored.',
        'restore-pending': 'Deletion interrupted. Session restoration is pending; try again shortly.',
        'recovery-pending': 'Could not confirm deletion result. Automatic recovery is pending.',
        'cleanup-pending': 'Previous deletion is still finishing cleanup. Try again shortly.',
        busy: 'Session is running. Stop it first.', locked: 'Session is in use and cannot be deleted right now.',
        missing: 'Session not found.', changed: 'Session state changed. Try again.',
        unsupported: 'Session deletion is not supported for this storage.', 'unsafe-path': 'Invalid session file path.',
        'cross-device': 'Session and plugin staging directories are on different volumes.',
        collision: 'Session directory conflict detected. Check the directory or try again.',
        'dependent-fork': 'An unmigrated fork still depends on this session.',
        'authentication-required': 'Sign in required.',
        unconfirmed: 'Could not confirm whether the session was deleted. Refresh the session list to check.',
        failed: 'Failed to delete session. Try again.',
      },
    };
    const errors = new Set([
      'busy', 'locked', 'missing', 'changed', 'unsupported', 'unsafe-path', 'cross-device', 'collision',
      'dependent-fork', 'authentication-required', 'unconfirmed',
      'restored', 'restore-pending', 'recovery-pending', 'cleanup-pending',
    ]);
    const dangerColor = 'var(--dsw-alias-state-error-primary)';
    const progressStyles = `
      .dsh-session-delete-progress {
        position: fixed;
        top: 40px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1100;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 10px;
        box-sizing: border-box;
        width: max-content;
        max-width: min(640px, calc(100vw - 48px));
        padding: 12px 16px;
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-toast-bg);
        color: var(--dsw-alias-toast-label);
        box-shadow: var(--dsw-shadow-lv3);
        font-size: 14px;
        line-height: 22px;
        animation: dsh-session-delete-toast-in 160ms ease-out;
      }
      .dsh-session-delete-progress .dsh-session-delete-spinner {
        color: var(--dsw-alias-toast-action);
      }
      .dsh-session-delete-progress-text {
        min-width: 0;
      }
      @keyframes dsh-session-delete-toast-in {
        from { opacity: 0; transform: translate(-50%, -6px); }
        to { opacity: 1; transform: translate(-50%, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsh-session-delete-progress { animation: none; }
      }
    `;

    return {
      inject: ['contextMenus', 'locale', 'slots', 'workspaces', 'remoteAccess'],
      apply(ctx) {
        const menus = ctx.contextMenus;
        const t = ctx.locale.bind(namespace);
        const dialog = createSnapshotStore(null);
        const toast = createSnapshotStore(null);
        const busy = createSnapshotStore(false);
        const lifetime = new AbortController();
        const activeBlocks = new Set();
        let checking = false;
        let deleting = false;
        let toastSequence = 0;

        function syncBusy() {
          const next = checking || deleting;
          if (busy.getSnapshot() !== next) busy.set(next);
        }

        function lockComposers(sessionIds) {
          const blocks = ctx.get?.('conversation')?.blocks;
          if (!blocks?.storeFor || !blocks?.set) return [];
          const block = { reason: t('pending') };
          const locked = [];
          for (const sessionId of sessionIds) {
            if (blocks.storeFor(sessionId).getSnapshot() !== undefined) continue;
            blocks.set(sessionId, block);
            const entry = { blocks, sessionId, block, cancel: undefined };
            activeBlocks.add(entry);
            locked.push(entry);
          }
          return locked;
        }

        function releaseBlock(entry) {
          activeBlocks.delete(entry);
          entry.cancel?.();
          if (entry.blocks.storeFor(entry.sessionId).getSnapshot() === entry.block) {
            entry.blocks.set(entry.sessionId, undefined);
          }
        }

        function settleBlocks(entries, deleted) {
          const sessions = deleted ? ctx.get?.('sessions') : undefined;
          const list = sessions?.list;
          for (const entry of entries) {
            const removed = sessions?.binding?.(entry.sessionId)?.session?.getSnapshot?.().removed === true;
            const listed = list && Object.prototype.hasOwnProperty.call(list.getSnapshot().byId, entry.sessionId);
            if (!deleted || removed || !listed) {
              releaseBlock(entry);
              continue;
            }
            let stop;
            let timer;
            entry.cancel = () => {
              stop?.();
              clearTimeout(timer);
              entry.cancel = undefined;
            };
            stop = list.subscribe(() => {
              if (!Object.prototype.hasOwnProperty.call(list.getSnapshot().byId, entry.sessionId)) {
                releaseBlock(entry);
              }
            });
            timer = setTimeout(() => releaseBlock(entry), 2000);
          }
        }

        function notify(key, tone = 'warning') {
          toast.set({ key, tone, seq: ++toastSequence });
        }

        async function request(body) {
          let response;
          try {
            response = await fetch('api/session-delete/session', {
              method: 'POST', credentials: 'same-origin', signal: lifetime.signal,
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
          } catch (error) {
            if (lifetime.signal.aborted) throw error;
            throw new Error(body.action === 'delete' ? 'unconfirmed' : 'failed');
          }
          const result = await response.json().catch(() => null);
          if (!response.ok || !result || result.error) {
            const accessDenied = response.status === 401 || response.status === 403;
            if (!result && !accessDenied && body.action === 'delete') throw new Error('unconfirmed');
            throw new Error(result?.error ?? (accessDenied ? 'authentication-required' : 'failed'));
          }
          return result;
        }

        function notifyError(error) {
          if (!lifetime.signal.aborted) notify(errors.has(error.message) ? error.message : 'failed');
        }

        async function preview({ sessionId, displayTitle }) {
          if (checking || deleting || dialog.getSnapshot() !== null) return;
          checking = true;
          syncBusy();
          try {
            const { ticket, count, memberIds } = await request({ action: 'preview', id: sessionId });
            if (lifetime.signal.aborted) return;
            if (typeof ticket !== 'string' || !ticket || !Number.isSafeInteger(count) || count < 0) throw new Error('failed');
            const extraIds = Array.isArray(memberIds) ? memberIds.filter((id) => typeof id === 'string' && id) : [];
            const ids = [...new Set([sessionId, ...extraIds])];
            dialog.set({ sessionId, memberIds: ids, title: displayTitle?.trim(), ticket, count });
          } catch (error) {
            notifyError(error);
          } finally {
            checking = false;
            syncBusy();
          }
        }

        function dismiss() {
          dialog.set(null);
        }

        async function confirm() {
          const current = dialog.getSnapshot();
          if (!current || deleting) return;
          deleting = true;
          syncBusy();
          const locked = lockComposers(current.memberIds);
          dialog.set(null);
          toast.set({ key: 'pending' });
          let deleted = false;
          try {
            const result = await request({ action: 'delete', id: current.sessionId, ticket: current.ticket });
            if (lifetime.signal.aborted) return;
            if (result.deleted !== true) throw new Error('unconfirmed');
            deleted = true;
            if (result.cleanupPending) notify('cleanupPending');
            else notify('deleted', 'success');
          } catch (error) {
            notifyError(error);
          } finally {
            deleting = false;
            syncBusy();
            settleBlocks(locked, deleted && !lifetime.signal.aborted);
            if (!deleted && !lifetime.signal.aborted) {
              void Promise.resolve(ctx.get?.('sessions')?.refresh?.()).catch(() => {});
            }
            if (!lifetime.signal.aborted && toast.getSnapshot()?.key === 'pending') toast.set(null);
          }
        }

        function DeleteToast({ t, renderFactorySlot }) {
          const current = useSyncExternalStore(toast.subscribe, toast.getSnapshot);
          const pending = current?.key === 'pending';
          const progress = h('div', { role: 'status', style: { pointerEvents: 'none' } },
            pending ? h('div', { className: 'dsh-session-delete-progress' },
              h(StateDot, { state: 'ongoing', size: 18, className: 'dsh-session-delete-spinner' }),
              h('span', { className: 'dsh-session-delete-progress-text' }, t(current.key)),
            ) : null,
          );
          const outcome = current && !pending ? renderFactorySlot('workspace.toast.content', {
            seq: current.seq,
            text: t(current.key),
            tone: current.tone,
            onDone: () => {
              if (toast.getSnapshot() === current) toast.set(null);
            },
          }) : null;
          return h(Fragment, null,
            pending ? h('style', null, progressStyles) : null,
            typeof document !== 'undefined' && document.body ? createPortal(progress, document.body) : progress,
            outcome,
          );
        }

        function DeleteDialog({ t }) {
          const current = useSyncExternalStore(dialog.subscribe, dialog.getSnapshot);
          const descriptionId = useId();
          if (!current) return null;
          const { title, count } = current;
          const message = count === 0 ? 'scope' : count === 1 ? 'scopeWithChild' : 'scopeWithChildren';
          const description = t(message, { title: title || t('untitled'), count });
          return h(Fragment, null,
            // DSH Modal only exposes a warning tone. Recolor its native icon for this dialog.
            h('style', null, `
              .dsh-session-delete-confirm h2 > svg[aria-hidden="true"] { color: ${dangerColor}; }
              .dsh-session-delete-confirm .dsh-session-delete-confirm-action {
                --dsw-alias-button-primary-fill: ${dangerColor};
                --dsw-alias-button-primary-hover: ${dangerColor};
              }
            `),
            h(Modal, {
              open: true, className: 'dsh-session-delete-confirm', tone: 'warning',
              title: t('title'), description, closeLabel: t('close'), onClose: dismiss,
              footer: h(Fragment, null,
                h('span', { id: descriptionId, hidden: true }, description),
                h(Button, { variant: 'outline', 'data-modal-autofocus': true, 'aria-describedby': descriptionId,
                  onClick: dismiss }, t('cancel')),
                h(Button, { variant: 'primary', className: 'dsh-session-delete-confirm-action',
                  'aria-describedby': descriptionId, onClick: confirm }, t('confirm'))),
            }));
        }

        const archiveAccess = ({ sessionId }) => ctx.remoteAccess.source('session', sessionId, 'workspace/archiveSession');
        const unarchiveAccess = ({ sessionId }) => ctx.remoteAccess.source('session', sessionId, 'workspace/unarchiveSession');
        ctx.effect(() => () => {
          lifetime.abort();
          checking = false;
          deleting = false;
          syncBusy();
          for (const entry of [...activeBlocks]) releaseBlock(entry);
          dialog.set(null);
          toast.set(null);
        });
        ctx.effect(() => ctx.locale.register(namespace, strings));
        ctx.effect(() => menus.register({
          id: 'session.delete-permanently', target: 'session', order: 601,
          observe: (target) => [ctx.locale, ctx.workspaces.list, archiveAccess(target), unarchiveAccess(target), busy, dialog],
          resolve: (target) => {
            const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(target.sessionId);
            const access = archived ? unarchiveAccess(target) : archiveAccess(target);
            const disabled = busy.getSnapshot() || dialog.getSnapshot() !== null;
            return access.getSnapshot() ? [{
              id: 'delete', label: t('remove'), icon: { key: 'workspace.delete' }, danger: true, afterContent: true,
              ...(disabled ? { disabled: true } : {}),
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
