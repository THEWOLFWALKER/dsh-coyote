import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GuiBridge } from '../src/gui/bridge.ts'
import { CoyoteRuntime } from '../src/runtime/runtime.ts'

interface GuiEvent {
  event: string
  status?: { state: string; playing?: boolean; cooldownRemainingSec?: number; importedCount?: number }
  waveforms?: Array<{ id: string; source: string }>
  op?: string
  message?: string
}

/** Mock browser panel speaking the /gui JSON protocol. */
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

describe('coyote gui bridge', () => {
  let dir: string
  let runtime: CoyoteRuntime
  let bridge: GuiBridge
  let guiUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coyote-gui-'))
  })

  afterEach(async () => {
    bridge?.dispose()
    await runtime?.dispose()
  })

  async function makeRuntime(): Promise<void> {
    runtime = new CoyoteRuntime(
      { server: { port: 0, bindTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 }, waveformDir: dir, sessionCooldownSec: 0 },
      () => {},
    )
    bridge = new GuiBridge(runtime)
    runtime.mountGui(socket => bridge.handleConnection(socket))
    const address = await runtime.start()
    guiUrl = `ws://127.0.0.1:${address.port}/gui`
  }

  it('greets a panel with status and the waveform library', async () => {
    await makeRuntime()
    const panel = new MockPanel(guiUrl)
    await panel.opened()
    try {
      const status = await panel.waitFor(e => e.event === 'status')
      expect(status.status?.state).toBe('idle')
      const waves = await panel.waitFor(e => e.event === 'waveforms')
      expect(waves.waveforms).toHaveLength(12)
    } finally {
      panel.close()
    }
  })

  it('pairs through the panel and pushes session status', async () => {
    await makeRuntime()
    const panel = new MockPanel(guiUrl)
    await panel.opened()
    try {
      panel.send({ op: 'pair' })
      const ack = await panel.waitFor(e => e.event === 'ack' && e.op === 'pair')
      expect(ack).toBeDefined()
      const status = await panel.waitFor(e => e.event === 'status' && e.status?.state === 'waiting-app')
      expect(status).toBeDefined()
    } finally {
      panel.close()
    }
  })

  it('rejects strength ops while unbound and bad frames politely', async () => {
    await makeRuntime()
    const panel = new MockPanel(guiUrl)
    await panel.opened()
    try {
      panel.send({ op: 'strength', channel: 'A', value: 10 })
      expect(await panel.waitFor(e => e.event === 'error')).toMatchObject({ event: 'error' })

      panel.send({ op: 'wat' })
      const unknown = await panel.waitFor(e => e.event === 'error' && (e.message?.includes('unknown op') ?? false))
      expect(unknown.message).toContain('unknown op')

      panel.socket.send('not-json')
      const malformed = await panel.waitFor(e => e.event === 'error' && (e.message?.includes('JSON') ?? false))
      expect(malformed.message).toContain('JSON')
    } finally {
      panel.close()
    }
  })

  it('rejects oversized import payloads before parsing', async () => {
    await makeRuntime()
    const panel = new MockPanel(guiUrl)
    await panel.opened()
    try {
      panel.send({ op: 'import', text: 'x'.repeat(2_000_001) })
      const error = await panel.waitFor(e => e.event === 'error' && (e.message?.includes('exceeds') ?? false))
      expect(error.message).toContain('2')
      expect(runtime.status().importedCount).toBe(0)
    } finally {
      panel.close()
    }
  })

  it('drives strength, playback, and panic through the same envelope as tools', async () => {
    await makeRuntime()
    const session = await runtime.pair()
    const match = /ws:\/\/([^/]+):(\d+)\//.exec(session.qrPayload)!

    // Frame handler is attached pre-open and buffers everything: the server's
    // initial bind frame can arrive in the same I/O tick as 'open'.
    const appFrames: Array<{ type: string; message: string; clientId?: string; targetId?: string }> = []
    const app = new WebSocket(`ws://${match[1]}:${match[2]}/${session.controlId}`)
    app.on('message', data => appFrames.push(JSON.parse(String(data))))
    await new Promise(resolve => app.once('open', resolve))

    await vi.waitFor(() => expect(appFrames.some(f => f.type === 'bind' && f.targetId === '')).toBe(true))
    const initial = appFrames.find(f => f.type === 'bind' && f.targetId === '')!
    app.send(JSON.stringify({ type: 'bind', clientId: session.controlId, targetId: initial.clientId, message: 'DGLAB' }))

    await vi.waitFor(() => expect(appFrames.some(f => f.type === 'bind' && f.message === '200')).toBe(true))
    app.send(JSON.stringify({
      type: 'msg', clientId: 'app', targetId: 'ctrl', message: 'strength-0+0+100+100',
    }))

    const panel = new MockPanel(guiUrl)
    await panel.opened()
    try {
      await vi.waitFor(() => expect(runtime.status().state).toBe('bound'))

      panel.send({ op: 'strength', channel: 'A', value: 30 })
      await panel.waitFor(e => e.event === 'ack' && e.op === 'strength')
      await vi.waitFor(() => expect(appFrames.some(f => f.message === 'strength-1+2+30')).toBe(true))

      panel.send({ op: 'play', waveform: 'breath', channel: 'both', mode: 'loop', duration_sec: 2 })
      await panel.waitFor(e => e.event === 'ack' && e.op === 'play')
      await vi.waitFor(() => expect(appFrames.some(f => f.message.startsWith('pulse-A:'))).toBe(true))
      const playing = await panel.waitFor(e => e.event === 'status' && e.status?.playing === true)
      expect(playing).toBeDefined()

      panel.send({ op: 'panic' })
      await panel.waitFor(e => e.event === 'ack' && e.op === 'panic')
      await vi.waitFor(() => expect(appFrames.some(f => f.message === 'strength-1+2+0')).toBe(true))
      await panel.waitFor(e => e.event === 'status' && e.status?.playing === false)
    } finally {
      panel.close()
      app.close()
      await vi.waitFor(() => expect(runtime.status().state).toBe('idle'))
    }
  })

  it('broadcasts status to every open panel and supports imports', async () => {
    await makeRuntime()
    const panelA = new MockPanel(guiUrl)
    const panelB = new MockPanel(guiUrl)
    await panelA.opened()
    await panelB.opened()
    try {
      panelA.send({ op: 'import', text: JSON.stringify([{ name: 'Gui Wave', pulseData: ['0a0a0a0a000a141e'] }]) })
      const updated = await panelA.waitFor(e => e.event === 'waveforms' && (e.waveforms?.length ?? 0) === 13)
      expect(updated.waveforms?.some(wave => wave.id === 'Gui Wave')).toBe(true)
      // The other panel hears the library change too.
      await panelB.waitFor(e => e.event === 'waveforms' && (e.waveforms?.length ?? 0) === 13)
    } finally {
      panelA.close()
      panelB.close()
    }
  })
})
