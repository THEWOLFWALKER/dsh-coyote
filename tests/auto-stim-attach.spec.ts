import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import { attachAutoStim } from '../src/auto-stim/attach.ts'
import { AutoStimEngine } from '../src/auto-stim/engine.ts'
import { EventMapper } from '../src/auto-stim/mapper.ts'
import { normalizeAutoStimConfig } from '../src/auto-stim/rules.ts'
import { GuiBridge } from '../src/gui/bridge.ts'
import { CoyoteRuntime } from '../src/runtime/runtime.ts'
import type { AutoStimEvent } from '../src/auto-stim/rules.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Minimal cordis Context double: just enough `on` for the attach layer. */
class FakeCtx {
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>()

  on(name: string, listener: (...args: unknown[]) => void): () => void {
    const list = this.handlers.get(name) ?? []
    list.push(listener)
    this.handlers.set(name, list)
    return () => {
      const kept = (this.handlers.get(name) ?? []).filter(h => h !== listener)
      this.handlers.set(name, kept)
    }
  }

  emit(name: string, ...args: unknown[]): void {
    for (const handler of [...this.handlers.get(name) ?? []]) handler(...args)
  }

  get asContext(): Context {
    return this as unknown as Context
  }
}

describe('auto-stim attach layer', () => {
  let logs: string[]
  let ctx: FakeCtx
  let handled: AutoStimEvent[]
  let mapper: EventMapper

  beforeEach(() => {
    logs = []
    handled = []
    ctx = new FakeCtx()
    mapper = new EventMapper({ tickIntervalSec: 5 })
  })

  function attach(handle: (event: AutoStimEvent) => void = e => handled.push(e)): void {
    attachAutoStim(ctx.asContext, mapper, { handle } as unknown as AutoStimEngine, m => logs.push(m))
  }

  it('pipes session events through the mapper into the engine', () => {
    attach()
    ctx.emit('session/event', { type: 'whatever' }, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent)
    ctx.emit('session/event', { type: 'whatever' }, { type: 'tool/call', seq: 2, time: 0, data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{}' } } as SessionEvent)
    expect(handled).toEqual(['turn_start', 'tool_call'])
  })

  it('pipes cordis agent/error events', () => {
    attach()
    ctx.emit('agent/error', { turn: 3, error: new Error('x') })
    ctx.emit('agent/error', { turn: 3, error: new Error('x') })
    expect(handled).toEqual(['agent_error'])
  })

  it('pipes the agent/status running→idle edge', () => {
    attach()
    ctx.emit('agent/status', { status: 'running' })
    ctx.emit('agent/status', { status: 'idle' })
    expect(handled).toEqual(['agent_idle'])
  })

  it('swallows mapper exceptions and logs them', () => {
    const boom = vi.fn(() => {
      throw new Error('mapper exploded')
    })
    mapper.sessionEvent = boom
    attach()
    expect(() =>
      ctx.emit('session/event', {}, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent),
    ).not.toThrow()
    expect(logs.some(l => l.includes('session/event handler failed'))).toBe(true)
  })
})

describe('auto-stim GUI surface', () => {
  let dir: string
  let runtime: CoyoteRuntime
  let bridge: GuiBridge
  let guiUrl: string
  let engine: AutoStimEngine

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coyote-autostim-gui-'))
  })

  afterEach(async () => {
    bridge?.dispose()
    await runtime?.dispose()
  })

  async function makeBridge(withEngine: boolean): Promise<string> {
    runtime = new CoyoteRuntime(
      {
        server: { port: 0, bindTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 },
        waveformDir: dir,
        sessionCooldownSec: 0,
      },
      () => {},
    )
    if (withEngine) {
      engine = new AutoStimEngine(runtime, normalizeAutoStimConfig({ cooldownSec: 0 }), () => {})
    }
    bridge = new GuiBridge(runtime, withEngine ? engine : undefined)
    runtime.mountGui(socket => bridge.handleConnection(socket))
    const address = await runtime.start()
    return `ws://127.0.0.1:${address.port}/gui`
  }

  interface GuiEvent {
    event: string
    status?: { autoStim?: { enabled: boolean; armed: boolean } }
    op?: string
    message?: string
  }

  class MockPanel {
    readonly socket: WebSocket
    private readonly events: GuiEvent[] = []

    constructor(url: string) {
      this.socket = new WebSocket(url)
      this.socket.on('message', data => this.events.push(JSON.parse(String(data))))
    }

    opened(): Promise<void> {
      return new Promise((resolve, reject) => {
        this.socket.once('open', resolve)
        this.socket.once('error', reject)
      })
    }

    send(op: Record<string, unknown>): void {
      this.socket.send(JSON.stringify(op))
    }

    async waitFor(test: (event: GuiEvent) => boolean, timeoutMs = 2_500): Promise<GuiEvent> {
      const found = this.events.find(test)
      if (found !== undefined) return found
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.socket.off('message', onMessage)
          reject(new Error(`timeout; saw ${JSON.stringify(this.events.slice(-6))}`))
        }, timeoutMs)
        const onMessage = (data: unknown): void => {
          const event = JSON.parse(String(data)) as GuiEvent
          if (test(event)) {
            clearTimeout(timer)
            this.socket.off('message', onMessage)
            resolve(event)
          }
        }
        this.socket.on('message', onMessage)
      })
    }

    close(): void {
      this.socket.close()
    }
  }

  it('rides the autoStim block on every status snapshot and honors the auto op', async () => {
    guiUrl = await makeBridge(true)
    const panel = new MockPanel(guiUrl)
    await panel.opened()
    try {
      const hello = await panel.waitFor(e => e.event === 'status')
      expect(hello.status?.autoStim).toMatchObject({ enabled: true, armed: true })

      panel.send({ op: 'auto', armed: false })
      await panel.waitFor(e => e.event === 'ack' && e.op === 'auto')
      const disarmed = await panel.waitFor(e => e.event === 'status' && e.status?.autoStim?.armed === false)
      expect(disarmed.status?.autoStim?.enabled).toBe(true)

      panel.send({ op: 'auto', armed: true })
      await panel.waitFor(e => e.event === 'status' && e.status?.autoStim?.armed === true)
    } finally {
      panel.close()
    }
  })

  it('rejects the auto op when auto-stim is disabled', async () => {
    guiUrl = await makeBridge(false)
    const panel = new MockPanel(guiUrl)
    await panel.opened()
    try {
      const hello = await panel.waitFor(e => e.event === 'status')
      expect(hello.status?.autoStim).toBeUndefined()
      panel.send({ op: 'auto', armed: false })
      const error = await panel.waitFor(e => e.event === 'error')
      expect(error.message).toMatch(/autoStim/)
    } finally {
      panel.close()
    }
  })
})
