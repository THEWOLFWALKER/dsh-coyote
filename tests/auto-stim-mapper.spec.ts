import { describe, expect, it } from 'vitest'
import { EventMapper } from '../src/auto-stim/mapper.ts'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'

/** Typed session-event builder: fills the seq/time envelope around `data`. */
function se<K extends SessionEventType>(type: K, data: SessionEventMap[K]): SessionEvent {
  return { type, seq: 1, time: 0, data } as SessionEvent
}

const turnStart = (turn: number) => se('turn/start', { turn })
// The mapper only reads shallow fields (turn, error presence, statuses); the
// deep StreamChunk/ToolResultMessage/CallId shapes come from dsh-llm and are
// cast here to keep the fixtures about mapping, not serialization.
const chunk = (turn: number) =>
  se('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', text: 'x' } } as SessionEventMap['assistant/chunk'])
const toolCall = (turn: number) =>
  se('tool/call', { turn, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } as SessionEventMap['tool/call'])
const toolResult = (turn: number, failed: boolean) =>
  se('tool/result', {
    turn,
    step: 1,
    message: { role: 'user', content: [] },
    ...(failed ? { error: { name: 'ToolError', code: 'E' } } : {}),
  } as unknown as SessionEventMap['tool/result'])
const turnEnd = (turn: number, reason: SessionEventMap['turn/end']['reason']) =>
  se('turn/end', { turn, reason })
const todoWrite = (statuses: Array<'pending' | 'in_progress' | 'completed'>) =>
  se('todo/write', { todos: statuses.map((status, i) => ({ content: `t${i}`, status })) })

describe('auto-stim event mapper', () => {
  function make(tickIntervalSec = 5, now?: () => number): EventMapper {
    return new EventMapper({ tickIntervalSec, ...(now === undefined ? {} : { now }) })
  }

  it('maps turn start', () => {
    expect(make().sessionEvent(turnStart(1))).toEqual(['turn_start'])
  })

  it('fires assistant_start on the first chunk of a turn, then goes quiet', () => {
    let t = 1000
    const mapper = make(5, () => t)
    expect(mapper.sessionEvent(chunk(1))).toEqual(['assistant_start'])
    expect(mapper.sessionEvent(chunk(1))).toEqual([])
    t += 60_000
    expect(mapper.sessionEvent(chunk(1))).toEqual(['stream_tick'])
    // A new turn re-arms the assistant_start edge.
    expect(mapper.sessionEvent(chunk(2))).toEqual(['assistant_start'])
  })

  it('throttles stream ticks to tickIntervalSec', () => {
    let t = 1000
    const mapper = make(2, () => t)
    mapper.sessionEvent(chunk(1))
    t += 1500
    expect(mapper.sessionEvent(chunk(1))).toEqual([])
    t += 600
    expect(mapper.sessionEvent(chunk(1))).toEqual(['stream_tick'])
    t += 100
    expect(mapper.sessionEvent(chunk(1))).toEqual([])
  })

  it('maps tool calls and only failing tool results', () => {
    const mapper = make()
    expect(mapper.sessionEvent(toolCall(1))).toEqual(['tool_call'])
    expect(mapper.sessionEvent(toolResult(1, true))).toEqual(['tool_error'])
    expect(mapper.sessionEvent(toolResult(2, false))).toEqual([])
  })

  it('maps every turn-end reason kind', () => {
    const mapper = make()
    expect(mapper.sessionEvent(turnEnd(1, { kind: 'completed' }))).toEqual(['turn_end_completed'])
    expect(mapper.sessionEvent(turnEnd(2, { kind: 'aborted', reason: { kind: 'user' } })))
      .toEqual(['turn_end_aborted'])
    expect(mapper.sessionEvent(turnEnd(3, { kind: 'interrupted' }))).toEqual(['turn_end_aborted'])
    expect(mapper.sessionEvent(turnEnd(4, { kind: 'blocked' }))).toEqual(['turn_end_aborted'])
    expect(mapper.sessionEvent(turnEnd(5, { kind: 'max-tokens' }))).toEqual(['turn_end_max_tokens'])
    expect(mapper.sessionEvent(turnEnd(6, { kind: 'error', error: { message: 'x', code: 'E' } })))
      .toEqual(['agent_error'])
  })

  it('deduplicates agent errors within a turn across both sources', () => {
    const mapper = make()
    // cordis agent/error first …
    expect(mapper.agentError(7)).toEqual(['agent_error'])
    expect(mapper.agentError(7)).toEqual([])
    // … then the session turn/end describing the same failure stays silent.
    expect(mapper.sessionEvent(turnEnd(7, { kind: 'error', error: { message: 'x', code: 'E' } })))
      .toEqual([])
    // A turn that only failed via the session path still fires.
    expect(mapper.sessionEvent(turnEnd(8, { kind: 'error', error: { message: 'x', code: 'E' } })))
      .toEqual(['agent_error'])
  })

  it('frees the dedup set as turns end', () => {
    const mapper = make()
    mapper.agentError(1)
    mapper.sessionEvent(turnEnd(1, { kind: 'completed' }))
    // Same turn number reused later (fresh session): fires again.
    expect(mapper.agentError(1)).toEqual(['agent_error'])
  })

  it('bounds the per-turn error-dedup set', () => {
    const mapper = make()
    for (let turn = 0; turn < 600; turn++) mapper.agentError(turn)
    expect((mapper as unknown as { erroredTurns: Set<number> }).erroredTurns.size).toBeLessThanOrEqual(512)
  })

  it('fires todo_clear once per distinct all-completed list', () => {
    const mapper = make()
    expect(mapper.sessionEvent(todoWrite(['pending', 'completed']))).toEqual([])
    expect(mapper.sessionEvent(todoWrite(['completed', 'completed']))).toEqual(['todo_clear'])
    expect(mapper.sessionEvent(todoWrite(['completed', 'completed']))).toEqual([])
    // Re-opening the list re-arms the edge for the next completion.
    expect(mapper.sessionEvent(todoWrite(['pending', 'completed']))).toEqual([])
    expect(mapper.sessionEvent(todoWrite(['completed', 'completed']))).toEqual(['todo_clear'])
    // An empty list is not a victory.
    expect(mapper.sessionEvent(todoWrite([]))).toEqual([])
  })

  it('fires agent_idle only on the running→idle edge', () => {
    const mapper = make()
    expect(mapper.agentStatus('running')).toEqual([])
    expect(mapper.agentStatus('idle')).toEqual(['agent_idle'])
    expect(mapper.agentStatus('idle')).toEqual([])
    expect(mapper.agentStatus('running')).toEqual([])
    expect(mapper.agentStatus('idle')).toEqual(['agent_idle'])
  })

  it('stays silent on every other session event type', () => {
    const mapper = make()
    expect(mapper.sessionEvent(se('step/start', { turn: 1, step: 1 }))).toEqual([])
    expect(mapper.sessionEvent(se('step/end', { turn: 1, step: 1 }))).toEqual([])
    expect(mapper.sessionEvent(se('session/end-seed', {}))).toEqual([])
  })
})
