const effect = Symbol.for('cordis.effect');
const original = Symbol.for('cordis.original');

function refuse(code) {
  throw Object.assign(new Error(`Session writer (${code})`), { code });
}

function uniqueEffect(fiber, label) {
  const effects = fiber?._disposables;
  if (!effects?.[Symbol.iterator]) return undefined;
  const matches = [...effects].filter((entry) => typeof entry === 'function' && entry[effect]?.label === label);
  if (matches.length === 1) return matches[0];
}

function assertNoWork(agent) {
  if (agent.status === 'running' || agent.phase?.kind === 'maintenance' || agent.inbox?.hasPending === true) refuse('busy');
  if (agent.status !== 'idle' || agent.phase?.kind !== 'idle' || agent.inbox?.hasPending !== false) refuse('locked');
}

/** The pinned DSH release stores Web Agent lifetime on the Session Controller fiber. */
export function idleWebWriter(ctx, session) {
  const agent = ctx.get('agents')?.get(session.id);
  if (agent?.session !== session) refuse('locked');
  const subagents = ctx.get('subagents');
  const manager = (subagents?.[original] ?? subagents)?.manager;
  const activation = manager?.resident?.get(session.id);
  if (session.header.origin === 'subagent' && activation?.kind === 'local' && activation.handle?.agent === agent) {
    // The manager already owns settlement and may notify the parent on close.
    // Wait for that native transition without cancelling or disposing the child.
    if (!activation.accepted || agent.inbox?.hasPending !== false || agent.status !== 'idle') refuse('busy');
    if (activation.closing === undefined && agent.phase?.kind !== 'idle') refuse('busy');
    return { session, agent, settling: true };
  }
  assertNoWork(agent);
  if (agent.lifetimeSignal?.aborted !== false || session.header.origin === 'subagent') refuse('locked');

  const service = ctx.get('sessionController');
  const controller = service?.[original] ?? service;
  const owner = controller?.agents?.ctx?.fiber;
  const scope = agent.scope?.rawDispose?.[effect];
  const scopeEffect = uniqueEffect(agent.loopCtx?.fiber, `agentLoop.scope(${session.id})`);
  const dispose = uniqueEffect(owner, `agentLoop.lifecycle(${session.id})`);
  // Verify the exact loop scope is still owned, and the individually named
  // native teardown belongs to the Web controller. Never unload either fiber.
  if (!owner || owner !== controller.ctx?.fiber || !scope
    || !scopeEffect?.[effect].children.includes(scope) || !dispose) refuse('locked');
  return { session, agent, dispose };
}

export async function releaseIdleWebWriters(ctx, writers) {
  for (const writer of writers) {
    const current = idleWebWriter(ctx, writer.session);
    if (ctx.sessions.get(writer.session.id) !== writer.session
      || current.agent !== writer.agent || current.dispose !== writer.dispose) refuse('changed');
  }
  // Start all native teardowns synchronously after the last idle check. No user
  // work is cancelled here. Confirmed deletion still requires the kernel locks.
  const outcome = await Promise.allSettled(writers.map(async ({ dispose }) => { await dispose(); }));
  for (const result of outcome) {
    if (result.status === 'rejected') throw result.reason;
  }
}
