import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { CoyoteServer, CoyoteServerHandlers } from '../src/transport/server.ts'
import { CoyoteServer as Server } from '../src/transport/server.ts'
import type { SocketFrame } from '../src/protocol/frames.ts'
import { encodeFrame } from '../src/protocol/frames.ts'

/** Mock App: a raw ws client speaking the V3 frame protocol. */
class MockApp {
  readonly socket: WebSocket
  private readonly frames: SocketFrame[] = []
  private readonly waiters: Array<{ test: (frame: SocketFrame) => boolean; resolve: (frame: SocketFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = []
  closed = false

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.on('message', data => {
      const frame = JSON.parse(String(data)) as SocketFrame
      this.frames.push(frame)
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i]!
        if (waiter.test(frame)) {
          clearTimeout(waiter.timer)
          this.waiters.splice(i, 1)
          waiter.resolve(frame)
        }
      }
    })
    this.socket.on('close', () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('socket closed while waiting'))
      }
    })
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
  }

  waitClose(timeoutMs = 2_000): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs)
      this.socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  next(test: (frame: SocketFrame) => boolean, timeoutMs = 2_000): Promise<SocketFrame> {
    const found = this.frames.find(test)
    if (found !== undefined) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error(`frame timeout; saw ${JSON.stringify(this.frames.map(f => f.message.slice(0, 40)))}`))
      }, timeoutMs) }
      this.waiters.push(waiter)
    })
  }

  send(frame: SocketFrame): void {
    this.socket.send(encodeFrame(frame))
  }

  close(): void {
    this.socket.close()
  }
}

describe('coyote server', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
  })

  afterEach(async () => {
    await vi.waitFor(() => {}, { timeout: 1 })
    vi.useRealTimers()
  })

  async function makeServer(handlers: CoyoteServerHandlers = {}): Promise<{ server: CoyoteServer; url: (path: string) => string }> {
    const server = new Server(
      { port: 0, bindTimeoutMs: 60_000 },
      { ...handlers, onLog: message => logs.push(message) },
    )
    const { port } = await server.start()
    return { server, url: path => `ws://127.0.0.1:${port}${path}` }
  }

  /** Full handshake: returns the bound mock App. */
  async function bindApp(server: CoyoteServer, url: (path: string) => string): Promise<{ app: MockApp; session: Awaited<ReturnType<typeof server.beginSession>> }> {
    const session = await server.beginSession()
    const app = new MockApp(url(`/${session.controlId}`))
    await app.opened()
    const initial = await app.next(frame => frame.type === 'bind' && frame.targetId === '')
    app.send({ type: 'bind', clientId: session.controlId, targetId: initial.clientId, message: 'DGLAB' })
    await app.next(frame => frame.type === 'bind' && frame.message === '200')
    return { app, session }
  }

  it('mints a session with the official QR shape and a data-url image', async () => {
    const { server } = await makeServer()
    try {
      const session = await server.beginSession()
      expect(session.controlId).toMatch(/^[0-9a-f]{32}$/)
      expect(session.qrPayload).toMatch(
        /^https:\/\/www\.dungeon-lab\.com\/app-download\.php#DGLAB-SOCKET#ws:\/\/[\w.:-]+\/[0-9a-f]{32}$/,
      )
      expect(session.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
      expect(server.state).toBe('waiting-app')
      // Idempotent while unbound.
      expect(await server.beginSession()).toEqual(session)
    } finally {
      await server.dispose()
    }
  })

  it('honors a publicWsUrl override for proxied deployments', async () => {
    const server = new Server({ port: 0, publicWsUrl: 'wss://stim.example.com/' }, { onLog: m => logs.push(m) })
    await server.start()
    try {
      const session = await server.beginSession()
      expect(session.qrPayload).toBe(`https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#wss://stim.example.com/${session.controlId}`)
    } finally {
      await server.dispose()
    }
  })

  it('completes the full bind handshake and reports bound state', async () => {
    const onBound = vi.fn()
    const { server, url } = await makeServer({ onBound })
    try {
      const { app } = await bindApp(server, url)
      expect(server.state).toBe('bound')
      expect(server.isBound()).toBe(true)
      expect(onBound).toHaveBeenCalledTimes(1)
      app.close()
      await vi.waitFor(() => expect(server.state).toBe('idle'))
      app.socket.terminate()
    } finally {
      await server.dispose()
    }
  })

  it('rejects connections with the wrong path and without a session', async () => {
    const { server, url } = await makeServer()
    try {
      const stranger = new MockApp(url('/nope'))
      await stranger.opened()
      await stranger.waitClose()
      expect(stranger.closed).toBe(true)

      const session = await server.beginSession()
      const wrong = new MockApp(url('/not-the-control-id'))
      await wrong.opened()
      await wrong.waitClose()
      expect(server.state).toBe('waiting-app')
      expect(session.controlId).toMatch(/^[0-9a-f]{32}$/)
    } finally {
      await server.dispose()
    }
  })

  it('rejects a second App while one is already connecting', async () => {
    const { server, url } = await makeServer()
    try {
      const session = await server.beginSession()
      const first = new MockApp(url(`/${session.controlId}`))
      await first.opened()
      const second = new MockApp(url(`/${session.controlId}`))
      await second.opened()
      await second.waitClose()
      expect(second.closed).toBe(true)
      first.close()
      await vi.waitFor(() => expect(server.state).toBe('waiting-app'))
    } finally {
      await server.dispose()
    }
  })

  it('tracks strength reports and feedback buttons from the App', async () => {
    const strengths: unknown[] = []
    const feedbacks: unknown[] = []
    const { server, url } = await makeServer({
      onStrength: s => strengths.push(s),
      onFeedback: f => feedbacks.push(f),
    })
    try {
      const { app } = await bindApp(server, url)
      app.send({ type: 'msg', clientId: 'app', targetId: 'ctrl', message: 'strength-11+7+100+35' })
      await vi.waitFor(() => expect(server.strength).toBeDefined())
      expect(server.strength).toEqual({ a: 11, b: 7, limitA: 100, limitB: 35 })
      expect(strengths).toHaveLength(1)

      app.send({ type: 'msg', clientId: 'app', targetId: 'ctrl', message: 'feedback-7' })
      await vi.waitFor(() => expect(feedbacks).toEqual([{ index: 7, channel: 'B' }]))
      app.close()
      await vi.waitFor(() => expect(server.state).toBe('idle'))
    } finally {
      await server.dispose()
    }
  })

  it('sends strength, pulse, and clear commands as protocol frames', async () => {
    const { server, url } = await makeServer()
    try {
      const { app } = await bindApp(server, url)
      await server.sendStrength('A', 2, 35)
      await server.sendPulse('B', ['0a0a0a0a000a141e'])
      await server.clearPulse('A')

      const strength = await app.next(f => f.message === 'strength-1+2+35')
      expect(strength.type).toBe('msg')
      expect(strength.clientId).toBe(server.controlId)
      const pulse = await app.next(f => f.message.startsWith('pulse-B:'))
      expect(JSON.parse(pulse.message.slice('pulse-B:'.length))).toEqual(['0a0a0a0a000a141e'])
      await app.next(f => f.message === 'clear-1')
      app.close()
      await vi.waitFor(() => expect(server.state).toBe('idle'))
    } finally {
      await server.dispose()
    }
  })

  it('refuses commands while unbound', async () => {
    const { server } = await makeServer()
    try {
      await expect(server.sendStrength('A', 1, 5)).rejects.toThrow(/no bound App/)
      await expect(server.sendPulse('A', ['0a0a0a0a000a141e'])).rejects.toThrow(/no bound App/)
      await expect(server.clearPulse('B')).rejects.toThrow(/no bound App/)
      await expect(server.beginSession()).resolves.toBeDefined()
      await expect(server.sendStrength('A', 1, 5)).rejects.toThrow(/no bound App/)
    } finally {
      await server.dispose()
    }
  })

  it('drops App sockets that never complete the DGLAB handshake', async () => {
    const server = new Server({ port: 0, bindTimeoutMs: 120 }, { onLog: m => logs.push(m) })
    const { port } = await server.start()
    try {
      const session = await server.beginSession()
      const silent = new MockApp(`ws://127.0.0.1:${port}/${session.controlId}`)
      await silent.opened()
      await silent.next(f => f.type === 'bind' && f.targetId === '')
      await silent.waitClose(2_000)
      expect(silent.closed).toBe(true)
      // The QR stays valid: another App may still connect and bind.
      const retry = new MockApp(`ws://127.0.0.1:${port}/${session.controlId}`)
      await retry.opened()
      const initial = await retry.next(f => f.type === 'bind' && f.targetId === '')
      retry.send({ type: 'bind', clientId: session.controlId, targetId: initial.clientId, message: 'DGLAB' })
      await retry.next(f => f.message === '200')
      expect(server.state).toBe('bound')
      retry.close()
      await vi.waitFor(() => expect(server.state).toBe('idle'))
    } finally {
      await server.dispose()
    }
  })

  it('sends break 209 and closes the socket on endSession', async () => {
    const onDisconnect = vi.fn()
    const { server, url } = await makeServer({ onDisconnect })
    try {
      const { app } = await bindApp(server, url)
      await server.endSession()
      const brk = await app.next(f => f.type === 'break')
      expect(brk.message).toBe('209')
      await app.waitClose()
      expect(server.state).toBe('idle')
      expect(server.controlId).toBeUndefined()
      // A fresh session mints a different control id.
      const next = await server.beginSession()
      expect(next.controlId).not.toBe(brk.clientId)
    } finally {
      await server.dispose()
    }
  })

  it('notifies onDisconnect once when the App vanishes mid-session', async () => {
    const onDisconnect = vi.fn()
    const { server, url } = await makeServer({ onDisconnect })
    try {
      const { app } = await bindApp(server, url)
      app.socket.terminate()
      await vi.waitFor(() => expect(server.state).toBe('idle'))
      expect(onDisconnect).toHaveBeenCalledTimes(1)
      expect(server.strength).toBeUndefined()
    } finally {
      await server.dispose()
    }
  })

  it('heartbeats the bound App on the configured interval', async () => {
    const server = new Server({ port: 0, heartbeatIntervalMs: 60 }, { onLog: m => logs.push(m) })
    const { port } = await server.start()
    try {
      const session = await server.beginSession()
      const app = new MockApp(`ws://127.0.0.1:${port}/${session.controlId}`)
      await app.opened()
      const initial = await app.next(f => f.type === 'bind' && f.targetId === '')
      app.send({ type: 'bind', clientId: session.controlId, targetId: initial.clientId, message: 'DGLAB' })
      await app.next(f => f.message === '200')
      const beat1 = await app.next(f => f.type === 'heartbeat')
      expect(beat1.message).toBe('200')
      const beat2 = await app.next(f => f.type === 'heartbeat')
      expect(beat2.clientId).toBe(initial.clientId)
      app.close()
      await vi.waitFor(() => expect(server.state).toBe('idle'))
    } finally {
      await server.dispose()
    }
  })

  it('ignores garbage frames without crashing', async () => {
    const { server, url } = await makeServer()
    try {
      const { app } = await bindApp(server, url)
      app.socket.send('this is not json')
      const errFrame = await app.next(f => f.type === 'error' && f.message === '403')
      expect(errFrame.targetId).toBeDefined()
      expect(server.state).toBe('bound')
      app.close()
      await vi.waitFor(() => expect(server.state).toBe('idle'))
    } finally {
      await server.dispose()
    }
  })
})
