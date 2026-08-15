import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { CoyoteRuntime } from '../src/runtime/runtime.ts'
import { createCoyoteTools } from '../src/tools/index.ts'
import type { DeviceStrength } from '../src/types.ts'

interface Frame {
  type: string
  clientId: string
  targetId: string
  message: string
}

/** Minimal App mock mirroring the runtime suite. */
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

const execStub = { signal: new AbortController().signal } as unknown as ToolRunContext

describe('coyote tools', () => {
  let dir: string
  let runtime: CoyoteRuntime
  let tools: ToolDefinition[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coyote-tools-'))
  })

  afterEach(async () => {
    await runtime?.dispose()
  })

  async function makeRuntime(overrides: Record<string, number> = {}): Promise<void> {
    runtime = new CoyoteRuntime(
      {
        server: { port: 0, bindTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 },
        waveformDir: dir,
        ...overrides,
      },
      () => {},
    )
    await runtime.start()
    tools = createCoyoteTools(runtime, { defaultPlaySec: 30, maxPlaySec: 600 })
  }

  async function bindApp(report: DeviceStrength = { a: 0, b: 0, limitA: 100, limitB: 100 }): Promise<MockApp> {
    const session = await runtime.pair()
    const match = /ws:\/\/[^/]+:(\d+)\//.exec(session.qrPayload)
    expect(match).not.toBeNull()
    const app = new MockApp(`ws://127.0.0.1:${match![1]}/${session.controlId}`)
    await app.opened()
    const initial = await app.waitFor(frame => frame.type === 'bind' && frame.targetId === '')
    app.send({ type: 'bind', clientId: session.controlId, targetId: initial.clientId, message: 'DGLAB' })
    await app.waitFor(frame => frame.type === 'bind' && frame.message === '200')
    app.report(report)
    await vi.waitFor(() => expect(runtime.status().strength).toBeDefined())
    return app
  }

  const tool = (name: string): ToolDefinition => {
    const found = tools.find(item => item.name === name)
    if (found === undefined) throw new Error(`tool ${name} missing`)
    return found
  }

  it('exposes exactly the eight coyote_* tools with full contracts', async () => {
    await makeRuntime()
    expect(tools.map(item => item.name)).toEqual([
      'coyote_status',
      'coyote_pair',
      'coyote_disconnect',
      'coyote_set_strength',
      'coyote_play_wave',
      'coyote_stop_wave',
      'coyote_panic_stop',
      'coyote_waveforms',
    ])
    for (const definition of tools) {
      expect(definition.description.length).toBeGreaterThan(40)
      expect(typeof definition.output.render).toBe('function')
      // The compiled parameter schema must survive the JSON Schema subset.
      expect(validateJsonSchemaValue(definition.parameters, {})).toBeInstanceOf(Array)
    }
  })

  it('coyote_status snapshots the runtime', async () => {
    await makeRuntime()
    const value = await tool('coyote_status').execute({}, execStub)
    expect(value).toMatchObject({ state: 'idle', playing: false, builtinCount: 12, importedCount: 0 })
  })

  it('coyote_pair mints a session and renders a compact summary', async () => {
    await makeRuntime()
    const value = await tool('coyote_pair').execute({}, execStub) as Record<string, string>
    expect(value.controlId).toMatch(/^[0-9a-f]{32}$/)
    expect(value.qrPayload).toContain('DGLAB-SOCKET')
    expect(value.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    const rendered = tool('coyote_pair').output.render({}, value as never)
    expect(rendered[0]?.type).toBe('text')
    expect(rendered[0] && 'text' in rendered[0]! ? rendered[0].text : '').toContain(value.controlId)
  })

  it('coyote_set_strength validates its parameter schema', async () => {
    await makeRuntime()
    const definition = tool('coyote_set_strength')
    const schema = definition.parameters
    // channel is required and enum-constrained at the schema level.
    expect(validateJsonSchemaValue(schema, {})).not.toHaveLength(0)
    expect(validateJsonSchemaValue(schema, { channel: 'C', value: 5 })).not.toHaveLength(0)
    expect(validateJsonSchemaValue(schema, { channel: 'both', value: 5 })).toHaveLength(0)
    // value/delta exclusivity is a runtime concern (JSON Schema cannot XOR
    // two optional properties in the supported subset).
    await expect(definition.execute({ channel: 'A' } as never, execStub)).rejects.toThrow(/either value or delta/)
  })

  it('coyote_set_strength drives the wire through the safety envelope', async () => {
    await makeRuntime({ softLimitA: 50, increaseBurst: 200 })
    const app = await bindApp()
    try {
      const value = await tool('coyote_set_strength').execute({ channel: 'A', value: 80 } as never, execStub) as {
        applied: { A?: number }
        requested: { A?: number }
        clampedBy?: string[]
      }
      expect(value.requested.A).toBe(80)
      expect(value.applied.A).toBe(50)
      expect(value.clampedBy).toEqual(['soft-limit'])
      expect(await app.waitFor(f => f.message === 'strength-1+2+50')).toBeDefined()
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('coyote_play_wave takes exactly one source and names it', async () => {
    await makeRuntime()
    const app = await bindApp()
    try {
      const summary = await tool('coyote_play_wave').execute({
        waveform: 'Heartbeat',
        channel: 'A',
        mode: 'once',
        duration_seconds: 1,
      } as never, execStub) as { source: string; channels: string[] }
      expect(summary.source).toBe('builtin:Heartbeat')
      expect(summary.channels).toEqual(['A'])
      expect(await app.waitFor(f => f.message.startsWith('pulse-A:'))).toBeDefined()

      await expect(tool('coyote_play_wave').execute({} as never, execStub)).rejects.toThrow(/exactly one/)
      await expect(tool('coyote_play_wave').execute({ waveform: 'x', hex_entries: ['0a0a0a0a000a141e'] } as never, execStub)).rejects.toThrow(/exactly one/)
      await expect(tool('coyote_play_wave').execute({ waveform: 'ghost' } as never, execStub)).rejects.toThrow(/coyote_waveforms/)
    } finally {
      await runtime.stopWave()
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('coyote_play_wave accepts spec and hex sources', async () => {
    await makeRuntime()
    const app = await bindApp()
    try {
      const spec = await tool('coyote_play_wave').execute({
        spec: {
          freq: { from: 200, to: 100, curve: 'sine' },
          intensity: { from: 10, to: 60, curve: 'sine' },
          durationSec: 1,
        },
      } as never, execStub) as { source: string }
      expect(spec.source).toBe('spec')
      await app.waitFor(f => f.message.startsWith('pulse-A:'))
      await runtime.stopWave()

      const hex = await tool('coyote_play_wave').execute({
        hex_entries: ['0a0a0a0a000a141e', '0a0a0a0a0a0a1e14'],
        channel: 'B',
      } as never, execStub) as { source: string; entryCount: number }
      expect(hex.source).toBe('hex')
      expect(hex.entryCount).toBe(2)
      expect(await app.waitFor(f => f.message.startsWith('pulse-B:'))).toBeDefined()
    } finally {
      await runtime.stopWave()
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('coyote_stop_wave and coyote_panic_stop converge to safe states', async () => {
    await makeRuntime()
    const app = await bindApp({ a: 30, b: 12, limitA: 100, limitB: 100 })
    try {
      await runtime.playWave({ source: { kind: 'builtin', id: 'tremor' }, channel: 'A', mode: 'loop', durationSec: 30 })
      await app.waitFor(f => f.message.startsWith('pulse-A:'))
      await tool('coyote_stop_wave').execute({}, execStub)
      expect(runtime.status().playing).toBe(false)
      expect(runtime.status().strength?.a).toBe(30)

      await tool('coyote_panic_stop').execute({}, execStub)
      expect(await app.waitFor(f => f.message === 'strength-1+2+0')).toBeDefined()
      expect(runtime.status().playing).toBe(false)
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('coyote_waveforms lists built-ins and imports community files', async () => {
    await makeRuntime()
    const listed = await tool('coyote_waveforms').execute({ action: 'list' } as never, execStub) as {
      waveforms: Array<{ id: string; source: string }>
    }
    expect(listed.waveforms).toHaveLength(12)
    expect(listed.waveforms.every(wave => wave.source === 'builtin')).toBe(true)

    const result = await tool('coyote_waveforms').execute({
      action: 'import',
      text: JSON.stringify([{ id: 7, name: 'Wave Seven', pulseData: ['0a0a0a0a000a141e'] }]),
      file_name: 'seven.pulses',
    } as never, execStub) as {
      imported: Array<{ name: string; entryCount: number }>
      waveforms: Array<{ id: string; source: string }>
    }
    expect(result.imported).toEqual([{ name: 'Wave Seven', entryCount: 1 }])
    expect(result.waveforms).toHaveLength(13)
    expect(result.waveforms.some(wave => wave.source === 'imported' && wave.id === 'Wave Seven')).toBe(true)

    await expect(tool('coyote_waveforms').execute({ action: 'import' } as never, execStub)).rejects.toThrow(/text/)
  })

  it('coyote_disconnect ends the session and reports the cooldown', async () => {
    await makeRuntime({ sessionCooldownSec: 5 })
    const app = await bindApp()
    const value = await tool('coyote_disconnect').execute({}, execStub) as { ended: boolean; cooldownRemainingSec: number }
    expect(value.ended).toBe(true)
    expect(value.cooldownRemainingSec).toBeGreaterThan(0)
    expect(await app.waitFor(f => f.type === 'break')).toBeDefined()
    expect(runtime.status().state).toBe('idle')
  })
})
