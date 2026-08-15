import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { AutoStimEngine } from '../src/auto-stim/engine.ts'
import { normalizeAutoStimConfig } from '../src/auto-stim/rules.ts'
import { CoyoteRuntime } from '../src/runtime/runtime.ts'
import type { DeviceStrength } from '../src/types.ts'

interface Frame {
  type: string
  clientId: string
  targetId: string
  message: string
}

/** Mock App speaking the V3 frame protocol (same contract as runtime.spec.ts). */
class MockApp {
  readonly socket: WebSocket
  private readonly frames: Frame[] = []
  closed = false

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.on('message', data => this.frames.push(JSON.parse(String(data))))
    this.socket.on('close', () => {
      this.closed = true
    })
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
  }

  messages(): string[] {
    return this.frames.map(frame => frame.message)
  }

  async waitFor(test: (frame: Frame) => boolean, timeoutMs = 2_500): Promise<Frame> {
    const found = this.frames.find(test)
    if (found !== undefined) return found
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage)
        reject(new Error(`timeout; saw ${JSON.stringify(this.messages().slice(-8))}`))
      }, timeoutMs)
      const onMessage = (data: unknown): void => {
        const frame = JSON.parse(String(data)) as Frame
        if (test(frame)) {
          clearTimeout(timer)
          this.socket.off('message', onMessage)
          resolve(frame)
        }
      }
      this.socket.on('message', onMessage)
    })
  }

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame))
  }

  close(): void {
    this.socket.close()
  }

  report(strength: DeviceStrength): void {
    this.send({
      type: 'msg',
      clientId: 'app',
      targetId: 'ctrl',
      message: `strength-${strength.a}+${strength.b}+${strength.limitA}+${strength.limitB}`,
    })
  }
}

describe('auto-stim engine', () => {
  let dir: string
  let logs: string[]
  let runtime: CoyoteRuntime
  let app: MockApp | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coyote-autostim-'))
    logs = []
  })

  afterEach(async () => {
    app?.close()
    app = undefined
    await runtime?.dispose()
  })

  function makeEngine(overrides: Record<string, unknown> = {}): AutoStimEngine {
    return new AutoStimEngine(
      runtime,
      normalizeAutoStimConfig({
        maxIntensity: 25,
        cooldownSec: 0,
        restoreBaseline: true,
        events: { tool_call: { intensity: 20, durationSec: 0.1, waveform: 'tap' } },
        ...overrides,
      }),
      message => logs.push(message),
    )
  }

  async function makeRuntime(): Promise<void> {
    runtime = new CoyoteRuntime(
      {
        server: { port: 0, bindTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 },
        waveformDir: dir,
        sessionCooldownSec: 0,
      },
      message => logs.push(message),
    )
    await runtime.start()
  }

  async function bindApp(report: DeviceStrength = { a: 5, b: 0, limitA: 100, limitB: 100 }): Promise<MockApp> {
    const session = await runtime.pair()
    const match = /ws:\/\/[^/]+:(\d+)\//.exec(session.qrPayload)
    expect(match).not.toBeNull()
    app = new MockApp(`ws://127.0.0.1:${match![1]}/${session.controlId}`)
    await app.opened()
    const initial = await app.waitFor(frame => frame.type === 'bind' && frame.targetId === '')
    app.send({ type: 'bind', clientId: session.controlId, targetId: initial.clientId, message: 'DGLAB' })
    await app.waitFor(frame => frame.type === 'bind' && frame.message === '200')
    app.report(report)
    await vi.waitFor(() => expect(runtime.status().strength).toBeDefined())
    return app
  }

  it('drops events while no App is bound', async () => {
    await makeRuntime()
    const engine = makeEngine()
    engine.handle('tool_call')
    await vi.waitFor(() => expect(engine.status().skipped).toBe(1))
    expect(engine.status().lastSkipReason).toBe('tool_call:not-bound')
    expect(engine.status().fired).toBe(0)
  })

  it('drops events for disabled rules and while disarmed', async () => {
    await makeRuntime()
    const engine = makeEngine()
    engine.handle('stream_tick') // disabled by default
    expect(engine.status().fired).toBe(0)
    expect(engine.status().skipped).toBe(0)
    engine.setArmed(false)
    engine.handle('tool_call')
    expect(engine.status().skipped).toBe(1)
    expect(engine.status().lastSkipReason).toBe('tool_call:disarmed')
  })

  it('boosts, plays, and restores the baseline for a bound App', async () => {
    await makeRuntime()
    const bound = await bindApp({ a: 5, b: 0, limitA: 100, limitB: 100 })
    const engine = makeEngine()

    engine.handle('tool_call')
    // Strength boost to the rule target lands on the wire (action 2 = set),
    // then the pulse.
    await bound.waitFor(frame => frame.message.startsWith('pulse-A:'))
    expect(bound.messages().some(m => m === 'strength-1+2+20')).toBe(true)

    await vi.waitFor(() => {
      expect(logs.some(l => l.includes('restored to A=5 B=0'))).toBe(true)
    }, 3_000)
    expect(engine.status().fired).toBe(1)
    expect(engine.status().inFlight).toBe(false)
  })

  it('enforces the cooldown between pulses', async () => {
    await makeRuntime()
    await bindApp()
    const engine = makeEngine({ cooldownSec: 30 })
    engine.handle('tool_call')
    await vi.waitFor(() => expect(engine.status().fired).toBe(1))

    engine.handle('tool_call')
    expect(engine.status().fired).toBe(1)
    expect(engine.status().skipped).toBeGreaterThanOrEqual(1)
    expect(engine.status().lastSkipReason).toMatch(/tool_call:(cooldown|busy)/)
    expect(engine.status().cooldownRemainingSec).toBeGreaterThan(0)
  })

  it('skips events while a pulse is busy', async () => {
    await makeRuntime()
    await bindApp()
    const engine = makeEngine({
      events: { tool_call: { intensity: 20, durationSec: 5, waveform: 'tap' } },
    })
    engine.handle('tool_call')
    await vi.waitFor(() => expect(engine.status().inFlight).toBe(true))
    engine.handle('tool_call')
    expect(engine.status().lastSkipReason).toBe('tool_call:busy')
    expect(engine.status().fired).toBe(1)
  })

  it('caps rule intensity at maxIntensity', async () => {
    await makeRuntime()
    const bound = await bindApp()
    const engine = makeEngine({
      maxIntensity: 15,
      events: { tool_call: { intensity: 200, durationSec: 0.1, waveform: 'tap' } },
    })
    engine.handle('tool_call')
    await bound.waitFor(frame => frame.message.startsWith('pulse-A:'))
    // The engine capped 200 at maxIntensity 15 before anything left the host.
    expect(bound.messages().some(m => m === 'strength-1+2+15')).toBe(true)
    expect(engine.status().fired).toBe(1)
  })

  it('restores immediately on dispose, cutting the margin wait', async () => {
    await makeRuntime()
    await bindApp()
    const engine = makeEngine({
      events: { tool_call: { intensity: 20, durationSec: 30, waveform: 'tap' } },
    })
    engine.handle('tool_call')
    await vi.waitFor(() => expect(engine.status().inFlight).toBe(true))

    const before = Date.now()
    engine.dispose()
    await vi.waitFor(() => {
      expect(logs.some(l => l.includes('restored to A=5 B=0'))).toBe(true)
    }, 3_000)
    expect(Date.now() - before).toBeLessThan(5_000)
    // After dispose the engine ignores everything.
    engine.handle('tool_call')
    expect(engine.status().fired).toBe(1)
  })

  it('survives an unknown waveform name (fail-soft, logged)', async () => {
    await makeRuntime()
    await bindApp()
    const engine = makeEngine({
      events: { tool_call: { intensity: 20, durationSec: 0.1, waveform: 'no-such-wave' } },
    })
    engine.handle('tool_call')
    await vi.waitFor(() => {
      expect(logs.some(l => l.includes('no-such-wave'))).toBe(true)
    }, 3_000)
    // .catch ran (log above); the .finally that clears inFlight follows it.
    await vi.waitFor(() => expect(engine.status().inFlight).toBe(false))
  })

  it('restores the baseline when the pulse fails mid-way', () => {
    // Stub runtime: bound at A=5, boost succeeds, playback explodes.
    const commands: string[] = []
    const fakeRuntime = {
      status: () => ({ state: 'bound', strength: { a: 5, b: 0, limitA: 100, limitB: 100 } }),
      setStrength: async (selection: string, { value }: { value: number }) => {
        commands.push(`set:${selection}=${value}`)
        return { applied: { A: value, B: value }, requested: { A: value, B: value } }
      },
      playWave: async () => {
        commands.push('play')
        throw new Error('app vanished mid-pulse')
      },
      listWaveforms: () => [{ id: 'tap', source: 'builtin', name: 'tap' }],
      stopWave: async () => {
        commands.push('stop')
      },
    } as unknown as CoyoteRuntime
    const engine = new AutoStimEngine(
      fakeRuntime,
      normalizeAutoStimConfig({ cooldownSec: 0, events: { tool_call: { intensity: 20, durationSec: 0.1 } } }),
      message => logs.push(message),
    )

    engine.handle('tool_call')
    return vi.waitFor(() => {
      // Boost to 20, playback attempt, restore back to the A=5 baseline.
      expect(commands).toEqual(['set:A=20', 'play', 'set:A=5'])
      expect(logs.some(l => l.includes('after failure'))).toBe(true)
      expect(engine.status().inFlight).toBe(false)
    }, 3_000)
  })
})
