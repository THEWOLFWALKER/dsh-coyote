/**
 * DSH host events → auto-stim domain events.
 *
 * The mapper is deliberately boring and total: it never throws, never touches
 * the device, and holds all the stateful judgments auto-stim needs
 * (deduplication, throttling, edge detection) so the engine stays a plain
 * gate-and-fire machine. It consumes the persisted-session firehose shape
 * (`session/event`, payload under `data`) plus two cordis runtime events
 * (`agent/error`, `agent/status`).
 *
 * Dedup model: `agent/error` (cordis) and `turn/end {kind:'error'}` both
 * describe the same failure and often both arrive. The first one per turn
 * number wins; the set entry is released when the turn ends.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AutoStimEvent } from './rules.ts'

/** Upper bound on the per-turn error-dedup set (turns that never closed). */
const MAX_ERROR_TURNS = 512

export interface EventMapperOptions {
  /** Minimum seconds between two stream ticks (from normalized settings). */
  tickIntervalSec: number
  /** Injectable clock for tests. */
  now?: () => number
}

export class EventMapper {
  private readonly tickMs: number
  private readonly now: () => number
  private lastAssistantTurn?: number
  private lastTickAt = 0
  private readonly erroredTurns = new Set<number>()
  private prevAgentStatus: string | undefined
  private lastTodoSignature: string | undefined

  constructor(options: EventMapperOptions) {
    this.tickMs = Math.max(1, options.tickIntervalSec) * 1000
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Map one persisted session event. Fires for every live session in the
   * host (subagent sessions included) — v0.2 reacts to all of them.
   */
  sessionEvent(event: SessionEvent): AutoStimEvent[] {
    switch (event.type) {
      case 'turn/start':
        return ['turn_start']
      case 'assistant/chunk': {
        const { turn } = event.data
        const now = this.now()
        if (turn !== this.lastAssistantTurn) {
          // First streamed chunk of a turn: the "model starts talking" edge.
          this.lastAssistantTurn = turn
          this.lastTickAt = now
          return ['assistant_start']
        }
        if (now - this.lastTickAt >= this.tickMs) {
          this.lastTickAt = now
          return ['stream_tick']
        }
        return []
      }
      case 'tool/call':
        return ['tool_call']
      case 'tool/result':
        return event.data.error !== undefined ? ['tool_error'] : []
      case 'turn/end': {
        const { turn, reason } = event.data
        let out: AutoStimEvent[] = []
        switch (reason.kind) {
          case 'completed':
            out = ['turn_end_completed']
            break
          case 'error':
            // Dedup against a prior agent/error for the same turn.
            out = this.erroredTurns.has(turn) ? [] : ['agent_error']
            break
          case 'aborted':
          case 'interrupted':
          case 'blocked':
            out = ['turn_end_aborted']
            break
          case 'max-tokens':
            out = ['turn_end_max_tokens']
            break
          default:
            // Merge-extensible reason kinds stay silent.
            break
        }
        this.erroredTurns.delete(turn)
        return out
      }
      case 'todo/write': {
        const todos = event.data.todos
        if (todos.length === 0) return []
        if (!todos.every(item => item.status === 'completed')) {
          this.lastTodoSignature = undefined
          return []
        }
        // The list snapshot repeats on every write; fire once per distinct
        // all-completed list.
        const signature = JSON.stringify(todos)
        if (signature === this.lastTodoSignature) return []
        this.lastTodoSignature = signature
        return ['todo_clear']
      }
      default:
        return []
    }
  }

  /** Map one cordis `agent/error` emit (`turn` numbers share the session space). */
  agentError(turn: number): AutoStimEvent[] {
    if (this.erroredTurns.has(turn)) return []
    this.erroredTurns.add(turn)
    if (this.erroredTurns.size > MAX_ERROR_TURNS) {
      const oldest = this.erroredTurns.values().next().value
      if (oldest !== undefined) this.erroredTurns.delete(oldest)
    }
    return ['agent_error']
  }

  /** Map one cordis `agent/status` emit; only the running→idle edge fires. */
  agentStatus(status: string): AutoStimEvent[] {
    const out: AutoStimEvent[] =
      this.prevAgentStatus === 'running' && status === 'idle' ? ['agent_idle'] : []
    this.prevAgentStatus = status
    return out
  }
}
