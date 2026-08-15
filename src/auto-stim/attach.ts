/**
 * Attach layer: the only auto-stim file that touches the cordis Context.
 *
 * Registers the three host listeners (session firehose, agent error, agent
 * status), pipes everything through the mapper into the engine, and wraps
 * every callback in a total try/catch — a plugin observer must never throw
 * into the host's event dispatch.
 *
 * `ctx.on` returns disposers, but cordis already drops plugin listeners on
 * unload; the engine's own timer state is what `apply`'s teardown effect
 * releases via `engine.dispose()`.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports that also pull the cordis Events augmentations for
// 'agent/error' and 'agent/status' into the program.
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AutoStimEngine } from './engine.ts'
import type { EventMapper } from './mapper.ts'

export function attachAutoStim(
  ctx: Context,
  mapper: EventMapper,
  engine: AutoStimEngine,
  log: (message: string) => void,
): void {
  const safe = (label: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      log(`auto-stim ${label} handler failed: ${String(error)}`)
    }
  }

  ctx.on('session/event', (_session, event: SessionEvent) => safe('session/event', () => {
    for (const domain of mapper.sessionEvent(event)) engine.handle(domain)
  }))

  ctx.on('agent/error', payload => safe('agent/error', () => {
    for (const domain of mapper.agentError(payload.turn)) engine.handle(domain)
  }))

  ctx.on('agent/status', payload => safe('agent/status', () => {
    const status: AgentStatus = payload.status
    for (const domain of mapper.agentStatus(status)) engine.handle(domain)
  }))
}
