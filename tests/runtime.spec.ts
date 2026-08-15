import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { CoyoteRuntime } from '../src/runtime/runtime.ts'
import type { DeviceStrength } from '../src/types.ts'

interface Frame {
  type: string
  clientId: string
  targetId: string
  message: string
}

/** Mock App speaking the V3 frame protocol against a real runtime. */
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

describe('coyote runtime', () => {
  let dir: string
  let logs: string[]
  let runtime: CoyoteRuntime

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coyote-runtime-'))
    logs = []
  })

  afterEach(async () => {
    await runtime?.dispose()
  })

  interface RuntimeOpts {
    softLimitA?: number
    softLimitB?: number
    sessionCooldownSec?: number
    maxSessionSec?: number
    maxPlaySec?: number
    increaseBurst?: number
    increaseRatePerSec?: number
  }

  async function makeRuntime(opts: RuntimeOpts = {}): Promise<void> {
    runtime = new CoyoteRuntime(
      {
        server: { port: 0, bindTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 },
        waveformDir: dir,
        ...opts,
      },
      message => logs.push(message),
    )
    await runtime.start()
  }

  async function bindApp(
    report: DeviceStrength = { a: 0, b: 0, limitA: 100, limitB: 100 },
  ): Promise<MockApp> {
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

  it('starts idle with a clean status and full built-in library', async () => {
    await makeRuntime()
    const status = runtime.status()
    expect(status.state).toBe('idle')
    expect(status.playing).toBe(false)
    expect(status.cooldownRemainingSec).toBe(0)
    expect(status.builtinCount).toBe(12)
    expect(status.importedCount).toBe(0)
    expect(runtime.listWaveforms()).toHaveLength(12)
  })

  it('validates configuration in the constructor', () => {
    expect(() => new CoyoteRuntime({ waveformDir: dir, softLimitA: 300 })).toThrow(/softLimitA/)
    expect(() => new CoyoteRuntime({ waveformDir: dir, maxPlaySec: 0 })).toThrow(/maxPlaySec/)
    expect(() => new CoyoteRuntime({ waveformDir: dir, increaseBurst: -1 })).toThrow(/increaseBurst/)
    expect(() => new CoyoteRuntime({ waveformDir: dir, sessionCooldownSec: -2 })).toThrow(/sessionCooldownSec/)
  })

  it('pairs, binds, and reports bound status with device limits', async () => {
    await makeRuntime({ softLimitA: 80 })
    const app = await bindApp({ a: 5, b: 3, limitA: 60, limitB: 100 })
    try {
      const status = runtime.status()
      expect(status.state).toBe('bound')
      expect(status.strength).toEqual({ a: 5, b: 3, limitA: 60, limitB: 100 })
      expect(status.effectiveLimitA).toBe(60)
      expect(status.effectiveLimitB).toBe(100)
      expect(status.session?.qrPayload).toContain('DGLAB-SOCKET')
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('sets absolute strength and sends action-2 commands on the wire', async () => {
    await makeRuntime()
    const app = await bindApp()
    try {
      const result = await runtime.setStrength('A', { value: 35 })
      expect(result.applied.A).toBe(35)
      expect(result.requested.A).toBe(35)
      expect(result.clampedBy).toBeUndefined()
      expect(await app.waitFor(f => f.message === 'strength-1+2+35')).toBeDefined()
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('clamps to the soft limit and reports why', async () => {
    // Big burst keeps the rate limiter out of the way so the test isolates
    // the soft-limit clamp (both limits compose in production).
    await makeRuntime({ softLimitA: 50, increaseBurst: 200 })
    const app = await bindApp({ a: 0, b: 0, limitA: 100, limitB: 100 })
    try {
      const result = await runtime.setStrength('A', { value: 80 })
      expect(result.requested.A).toBe(80)
      expect(result.applied.A).toBe(50)
      expect(result.clampedBy).toEqual(['soft-limit'])
      expect(await app.waitFor(f => f.message === 'strength-1+2+50')).toBeDefined()
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('clamps to the device-reported limit when it is lower', async () => {
    await makeRuntime({ increaseBurst: 200 })
    const app = await bindApp({ a: 0, b: 0, limitA: 40, limitB: 100 })
    try {
      const result = await runtime.setStrength('A', { value: 90 })
      expect(result.applied.A).toBe(40)
      expect(result.clampedBy).toEqual(['device-limit'])
      const both = await runtime.setStrength('A', { value: 10 })
      expect(both.applied.A).toBe(10)
      const up = await runtime.setStrength('A', { value: 150 })
      expect(up.applied.A).toBe(40)
      expect(up.clampedBy).toEqual(['device-limit', 'soft-limit'])
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('rate-limits increases asymmetrically and lets decreases through', async () => {
    await makeRuntime({ increaseBurst: 40, increaseRatePerSec: 40 })
    const app = await bindApp({ a: 0, b: 0, limitA: 200, limitB: 200 })
    try {
      // First jump can use the whole burst.
      const first = await runtime.setStrength('A', { value: 100 })
      expect(first.applied.A).toBe(40)
      expect(first.clampedBy).toEqual(['rate-limit'])
      expect(await app.waitFor(f => f.message === 'strength-1+2+40')).toBeDefined()

      // No refill yet: another increase stays pinned.
      const second = await runtime.setStrength('A', { value: 80 })
      expect(second.applied.A).toBe(40)

      // Decreases bypass the limiter entirely.
      const down = await runtime.setStrength('A', { value: 10 })
      expect(down.applied.A).toBe(10)
      expect(down.clampedBy).toBeUndefined()

      // After ~1s at 40/s the bucket refills enough for +40.
      await new Promise(resolve => setTimeout(resolve, 1_050))
      const up = await runtime.setStrength('A', { value: 50 })
      expect(up.applied.A).toBe(50)
      expect(up.clampedBy).toBeUndefined()
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('applies deltas against live reports and rejects them without a report', async () => {
    await makeRuntime()
    const app = await bindApp({ a: 20, b: 0, limitA: 100, limitB: 100 })
    try {
      const up = await runtime.setStrength('A', { delta: 5 })
      expect(up.applied.A).toBe(25)
      expect(await app.waitFor(f => f.message === 'strength-1+2+25')).toBeDefined()
      const down = await runtime.setStrength('B', { delta: -10 })
      expect(down.applied.B).toBe(0)
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('rejects strength commands while unbound', async () => {
    await makeRuntime()
    await expect(runtime.setStrength('A', { value: 10 })).rejects.toThrow(/no bound App/)
  })

  it('plays a built-in waveform on both channels and feeds the queue', async () => {
    await makeRuntime()
    const app = await bindApp()
    try {
      const summary = await runtime.playWave({
        source: { kind: 'builtin', id: 'heartbeat' },
        channel: 'both',
        mode: 'loop',
        durationSec: 2,
      })
      expect(summary.channels).toEqual(['A', 'B'])
      expect(summary.mode).toBe('loop')
      expect(summary.entryCount).toBeGreaterThan(0)
      const pulseA = await app.waitFor(f => f.message.startsWith('pulse-A:'))
      expect(JSON.parse(pulseA.message.slice('pulse-A:'.length))).toHaveLength(summary.entryCount > 70 ? 70 : summary.entryCount)
      await app.waitFor(f => f.message.startsWith('pulse-B:'))
      expect(runtime.status().playing).toBe(true)

      await runtime.stopWave()
      expect(runtime.status().playing).toBe(false)
      await app.waitFor(f => f.message === 'clear-1')
      await app.waitFor(f => f.message === 'clear-2')
    } finally {
      await runtime.stopWave()
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('caps playback duration at maxPlaySec', async () => {
    await makeRuntime({ maxPlaySec: 5 })
    const app = await bindApp()
    try {
      const summary = await runtime.playWave({
        source: { kind: 'builtin', id: 'breath' },
        channel: 'A',
        mode: 'loop',
        durationSec: 999,
      })
      expect(summary.durationSec).toBe(5)
      expect(logs.some(line => line.includes('capped'))).toBe(true)
    } finally {
      await runtime.stopWave()
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('scales waveform intensity when asked', async () => {
    await makeRuntime()
    const app = await bindApp()
    try {
      const full = await runtime.playWave({
        source: { kind: 'spec', spec: { freq: { from: 100, to: 100, curve: 'linear' }, intensity: { from: 80, to: 80, curve: 'linear' }, durationSec: 1 } },
        channel: 'A',
        mode: 'once',
        durationSec: 1,
      })
      const fullFrame = await app.waitFor(f => f.message.startsWith('pulse-A:'))
      const fullEntries = JSON.parse(fullFrame.message.slice('pulse-A:'.length)) as string[]
      expect(fullEntries[0]!.slice(8)).toMatch(/50/) // 80 -> hex 50

      await runtime.stopWave()
      const half = await runtime.playWave({
        source: { kind: 'spec', spec: { freq: { from: 100, to: 100, curve: 'linear' }, intensity: { from: 80, to: 80, curve: 'linear' }, durationSec: 1 } },
        channel: 'A',
        mode: 'once',
        durationSec: 1,
        intensityScalePercent: 50,
      })
      expect(half.entryCount).toBe(full.entryCount)
      const halfFrame = await app.waitFor(f => f.message.startsWith('pulse-A:') && f.message !== fullFrame.message)
      const halfEntries = JSON.parse(halfFrame.message.slice('pulse-A:'.length)) as string[]
      expect(Number.parseInt(halfEntries[0]!.slice(8, 10), 16)).toBe(40)
    } finally {
      await runtime.stopWave()
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('rejects unknown waveforms and invalid hex', async () => {
    await makeRuntime()
    const app = await bindApp()
    try {
      await expect(runtime.playWave({ source: { kind: 'builtin', id: 'nope' }, channel: 'A', mode: 'once', durationSec: 1 })).rejects.toThrow(/unknown built-in/)
      await expect(runtime.playWave({ source: { kind: 'hex', entries: ['zz'] }, channel: 'A', mode: 'once', durationSec: 1 })).rejects.toThrow(/16 hex/)
      await expect(runtime.playWave({ source: { kind: 'imported', name: 'ghost' }, channel: 'A', mode: 'once', durationSec: 1 })).rejects.toThrow(/unknown imported/)
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('panic-stops to zero strength and clears both queues', async () => {
    await makeRuntime()
    const app = await bindApp({ a: 30, b: 12, limitA: 100, limitB: 100 })
    try {
      await runtime.playWave({ source: { kind: 'builtin', id: 'tremor' }, channel: 'A', mode: 'loop', durationSec: 30 })
      await app.waitFor(f => f.message.startsWith('pulse-A:'))
      await runtime.panicStop()
      expect(await app.waitFor(f => f.message === 'strength-1+2+0')).toBeDefined()
      await app.waitFor(f => f.message === 'strength-2+2+0')
      await app.waitFor(f => f.message === 'clear-1')
      expect(runtime.status().playing).toBe(false)
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('fail-safes on App disconnect and arms the session cooldown', async () => {
    await makeRuntime({ sessionCooldownSec: 2 })
    const app = await bindApp()
    await runtime.playWave({ source: { kind: 'builtin', id: 'tremor' }, channel: 'A', mode: 'loop', durationSec: 30 })
    await app.waitFor(f => f.message.startsWith('pulse-A:'))

    app.socket.terminate()
    await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    expect(runtime.status().playing).toBe(false)
    expect(runtime.status().cooldownRemainingSec).toBeGreaterThan(0)
    await expect(runtime.pair()).rejects.toThrow(/cooldown/)

    // Adjustable: a zero cooldown never blocks.
    await runtime.dispose()
    await makeRuntime({ sessionCooldownSec: 0 })
    const free = await bindApp()
    expect(runtime.status().state).toBe('bound')
    free.close()
    await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    expect(runtime.status().cooldownRemainingSec).toBe(0)
    await expect(runtime.pair()).resolves.toBeDefined()
  })

  it('imports community waveforms, persists them, and plays them back', async () => {
    await makeRuntime()
    const text = JSON.stringify([
      { id: 1, name: 'Custom Zap', pulseData: ['0a0a0a0a000a141e', '0a0a0a0a0a0a1e14'] },
    ])
    const imported = await runtime.importWaveform(text, 'community.pulses')
    expect(imported).toHaveLength(1)
    expect(imported[0]!.entries).toHaveLength(2)
    expect(runtime.status().importedCount).toBe(1)

    const files = await readdir(dir)
    expect(files.some(file => file.endsWith('.pulses'))).toBe(true)
    const saved = JSON.parse(await readFile(join(dir, files.find(f => f.endsWith('.pulses'))!), 'utf8'))
    expect(saved[0].pulseData).toHaveLength(2)

    const listed = runtime.listWaveforms().find(wave => wave.source === 'imported')
    expect(listed?.id).toBe('Custom Zap')

    const app = await bindApp()
    try {
      const summary = await runtime.playWave({ source: { kind: 'imported', name: 'custom zap' }, channel: 'B', mode: 'once', durationSec: 1 })
      expect(summary.entryCount).toBe(2)
      const frame = await app.waitFor(f => f.message.startsWith('pulse-B:'))
      expect(JSON.parse(frame.message.slice('pulse-B:'.length))).toHaveLength(2)
    } finally {
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('loads persisted waveforms from the directory on start', async () => {
    await makeRuntime()
    await runtime.importWaveform(JSON.stringify([{ name: 'Keep', pulseData: ['0a0a0a0a000a141e'] }]), 'keep.pulses')
    await runtime.dispose()

    await makeRuntime()
    expect(runtime.status().importedCount).toBe(1)
    expect(runtime.listWaveforms().some(wave => wave.id === 'Keep')).toBe(true)
  })

  it('re-importing the same name replaces the entry instead of duplicating it', async () => {
    await makeRuntime()
    const first = JSON.stringify([{ name: 'Zap', pulseData: ['0a0a0a0a000a141e'] }])
    const second = JSON.stringify([{ name: 'Zap', pulseData: ['0a0a0a0a000a141e', '0a0a0a0a0a0a1e14'] }])
    await runtime.importWaveform(first, 'a.pulses')
    await runtime.importWaveform(second, 'b.pulses')

    expect(runtime.status().importedCount).toBe(1)
    const listed = runtime.listWaveforms().filter(wave => wave.id === 'Zap')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.entryCount).toBe(2)
  })

  it('ends sessions with a break frame and reusable port', async () => {
    await makeRuntime({ sessionCooldownSec: 1 })
    const app = await bindApp()
    await runtime.endSession()
    expect(await app.waitFor(f => f.type === 'break')).toBeDefined()
    expect(runtime.status().state).toBe('idle')
    await expect(runtime.pair()).rejects.toThrow(/cooldown/)
  })

  it('auto-ends over-long sessions via the hard cap', async () => {
    await makeRuntime({ maxSessionSec: 1, sessionCooldownSec: 0 })
    const app = await bindApp()
    try {
      expect(runtime.status().state).toBe('bound')
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'), { timeout: 4_000 })
      expect(logs.some(line => line.includes('max session'))).toBe(true)
      expect(app.closed || app.socket.readyState === WebSocket.CLOSED).toBe(true)
    } finally {
      app.close()
    }
  })
})
