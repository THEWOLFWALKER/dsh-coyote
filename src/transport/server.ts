/**
 * DG-LAB V3 socket transport: the WebSocket endpoint the official App
 * connects to, merged with the third-party control terminal role.
 *
 * Binding flow (DG-LAB-OPENSOURCE socket/README.md, 关系绑定):
 * 1. `beginSession` mints a 32-hex controlId and a QR payload
 *    `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://…/{controlId}`.
 * 2. The App scans the QR and connects to `ws://…/{controlId}`.
 * 3. We assign the App its own id and answer with the initial bind frame
 *    `{"type":"bind","clientId":appClientId,"targetId":"","message":appClientId}`
 *    (the demo frontend reads clientId when targetId is empty; the README
 *    wording also allows reading message — both carry the id).
 * 4. The App answers `{"type":"bind","clientId":controlId,"targetId":appClientId,"message":"DGLAB"}`.
 * 5. We confirm with the bind-ok frame (`message:"200"`); the relation is live.
 *
 * Heartbeat frames mirror the official demo backend: one per interval,
 * message "200", clientId set to the recipient's own id.
 */

import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import QRCode from 'qrcode'
import { CoyoteError } from '../errors.ts'
import {
  ERROR_CODES,
  bindOkFrame,
  breakFrame,
  clearMessage,
  encodeFrame,
  heartbeatFrame,
  parseFeedback,
  parseFrame,
  parseStrengthReport,
  pulseMessage,
  strengthCommand,
  type SocketFrame,
  type StrengthAction,
} from '../protocol/frames.ts'
import { buildQrPayload } from '../protocol/qr.ts'
import type { AppFeedback, Channel, ConnectionState, DeviceStrength } from '../types.ts'
import type { WaveTransport } from '../waveform/scheduler.ts'

/** Constructor options; every field has a protocol-derived default. */
export interface CoyoteServerOptions {
  /** Listen host. Default binds every interface so LAN phones can reach it. */
  host?: string
  /** Listen port. 0 (default) asks the OS for a free port. */
  port?: number
  /** QR WebSocket base URL override, e.g. `wss://proxy.example.com`. */
  publicWsUrl?: string
  /** Bind handshake timeout after the App socket opens (default 15s). */
  bindTimeoutMs?: number
  /** Heartbeat interval while bound (official demo: 60s). */
  heartbeatIntervalMs?: number
  /** Bindings for the QR data URL image. */
  qrWidth?: number
}

/** Server-side event callbacks; all optional, none may throw. */
export interface CoyoteServerHandlers {
  /** The App completed the DGLAB bind handshake. */
  onBound?: () => void
  /** The App reported new channel strengths or limits. */
  onStrength?: (strength: DeviceStrength) => void
  /** The App user tapped a feedback button. */
  onFeedback?: (feedback: AppFeedback) => void
  /** A bound session ended (socket close, send failure, or teardown). */
  onDisconnect?: (reason: string) => void
  /** Diagnostic log line. */
  onLog?: (message: string) => void
}

/** Everything the GUI and tools need about the pairing session. */
export interface SessionInfo {
  /** Our control-terminal id (32 hex chars, uuid-v4 shaped). */
  controlId: string
  /** Exact QR text the App must scan. */
  qrPayload: string
  /** Renderable `data:image/png;base64,…` QR image. */
  qrDataUrl: string
}

/** Handler for browser-panel connections on the `/gui` path. */
export type GuiConnectionHandler = (socket: WebSocket) => void

const DEFAULTS = {
  host: '0.0.0.0',
  port: 0,
  bindTimeoutMs: 15_000,
  heartbeatIntervalMs: 60_000,
  qrWidth: 240,
}

interface AppConnection {
  socket: WebSocket
  appClientId: string
  bound: boolean
  bindTimer?: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setInterval>
}

interface ActiveSession extends SessionInfo {
  app?: AppConnection | undefined
}

/** Pick the first non-internal IPv4 address for the default QR URL. */
function detectLanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}

function newId(): string {
  return randomUUID().replace(/-/g, '')
}

/**
 * The merged socket server + control terminal. Implements `WaveTransport`
 * so the scheduler can drive it directly.
 */
export class CoyoteServer implements WaveTransport {
  private wss: WebSocketServer | undefined
  private session: ActiveSession | undefined
  private disposed = false
  private guiHandler?: GuiConnectionHandler
  private readonly guiSockets = new Set<WebSocket>()
  /** Latest device-reported strengths while bound. */
  strength?: DeviceStrength | undefined

  constructor(
    private readonly options: CoyoteServerOptions = {},
    private readonly handlers: CoyoteServerHandlers = {},
  ) {}

  /** Current connection lifecycle state. */
  get state(): ConnectionState {
    if (this.session === undefined) return 'idle'
    return this.session.app?.bound === true ? 'bound' : 'waiting-app'
  }

  /** Whether the App completed binding and the socket is open. */
  isBound(): boolean {
    const app = this.session?.app
    return app !== undefined && app.bound && app.socket.readyState === WebSocket.OPEN
  }

  /** Our control id for the active session, when one exists. */
  get controlId(): string | undefined {
    return this.session?.controlId
  }

  /**
   * Route `/gui` connections to the browser-panel bridge. Call once before
   * `start()`; the server tracks GUI sockets so teardown can close them.
   */
  setGuiHandler(handler: GuiConnectionHandler): void {
    this.guiHandler = handler
  }

  /** Start listening. Safe to call once; resolves with the bound address. */
  async start(): Promise<{ host: string; port: number }> {
    if (this.wss !== undefined) throw new CoyoteError('coyote server already started')
    if (this.disposed) throw new CoyoteError('coyote server was disposed')
    const wss = new WebSocketServer({ host: this.options.host ?? DEFAULTS.host, port: this.options.port ?? DEFAULTS.port })
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve())
      wss.once('error', reject)
    })
    this.wss = wss
    wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request.url ?? '/').catch(error => {
        this.log(`connection handler failed: ${String(error)}`)
        socket.close(1011, 'server error')
      })
    })
    const address = wss.address()
    const port = typeof address === 'object' && address !== null ? address.port : this.options.port ?? 0
    this.log(`listening on ${this.options.host ?? DEFAULTS.host}:${port}`)
    return { host: this.options.host ?? DEFAULTS.host, port }
  }

  /**
   * Mint a pairing session (control id + QR). Idempotent while unbound:
   * calling again before the App binds returns the same session.
   */
  async beginSession(): Promise<SessionInfo> {
    if (this.disposed) throw new CoyoteError('coyote server was disposed')
    if (this.session?.app?.bound === true) {
      throw new CoyoteError('an App is already bound; end the session first', ERROR_CODES.ALREADY_BOUND)
    }
    if (this.session !== undefined) {
      return { controlId: this.session.controlId, qrPayload: this.session.qrPayload, qrDataUrl: this.session.qrDataUrl }
    }
    if (this.wss === undefined) throw new CoyoteError('coyote server not started')

    const controlId = newId()
    const address = this.wss.address()
    if (typeof address !== 'object' || address === null) throw new CoyoteError('coyote server has no address')
    const wildcard = address.address === '::' || address.address === '0.0.0.0'
    const host = wildcard ? detectLanAddress() : address.address
    const base = this.options.publicWsUrl?.replace(/\/+$/, '') ?? `ws://${host}:${address.port}`
    const qrPayload = buildQrPayload(base, controlId)
    const qrDataUrl = await QRCode.toDataURL(qrPayload, { margin: 1, width: this.options.qrWidth ?? DEFAULTS.qrWidth })
    this.session = { controlId, qrPayload, qrDataUrl }
    this.log(`session ${controlId} waiting for App at ${base}/${controlId}`)
    return { controlId, qrPayload, qrDataUrl }
  }

  /** Send one strength command to the bound App. */
  async sendStrength(channel: Channel, action: StrengthAction, value: number): Promise<void> {
    await this.sendCommand(strengthCommand(channel, action, value))
  }

  /** WaveTransport: one pulse segment (already capped at 100 by the caller). */
  async sendPulse(channel: Channel, entries: readonly string[]): Promise<void> {
    await this.sendCommand(pulseMessage(channel, entries))
  }

  /** WaveTransport: clear one channel's pending waveform queue. */
  async clearPulse(channel: Channel): Promise<void> {
    await this.sendCommand(clearMessage(channel))
  }

  /**
   * End the active session: notify a bound App with a break frame (209),
   * close the socket, and drop the QR. A fresh `beginSession` mints new ids.
   */
  async endSession(): Promise<void> {
    const app = this.session?.app
    if (app !== undefined) {
      if (app.bound && app.socket.readyState === WebSocket.OPEN) {
        await this.write(app, breakFrame(this.session!.controlId, app.appClientId, ERROR_CODES.PEER_DISCONNECTED))
      }
      await this.closeSocket(app)
    }
    this.session = undefined
    this.strength = undefined
  }

  /** Permanent teardown: end the session, drop GUI panels, stop listening. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.endSession()
    for (const socket of [...this.guiSockets]) {
      socket.close(1001, 'server teardown')
      this.guiSockets.delete(socket)
    }
    const wss = this.wss
    if (wss !== undefined) {
      await new Promise<void>(resolve => {
        wss.close(() => resolve())
      })
      this.wss = undefined
    }
  }

  private async handleConnection(socket: WebSocket, url: string): Promise<void> {
    // Browser-panel connections are independent of the pairing lifecycle.
    const path = url.split('?')[0] ?? url
    if (path === '/gui' || path === '/gui/') {
      if (this.guiHandler === undefined) {
        this.log('rejected GUI connection: no bridge mounted')
        socket.close(1008, 'gui bridge not enabled')
        return
      }
      this.guiSockets.add(socket)
      socket.on('close', () => this.guiSockets.delete(socket))
      this.guiHandler(socket)
      return
    }

    const session = this.session
    if (session === undefined || session.app?.bound === true || session.app !== undefined) {
      this.log(`rejected extra connection ${url}`)
      socket.close(1008, 'no pairing session')
      return
    }
    const expected = `/${session.controlId}`
    if (url !== expected && url !== `${expected}/`) {
      this.log(`rejected connection ${url}: path does not match the pairing id`)
      socket.close(1008, 'unknown pairing id')
      return
    }

    const appClientId = newId()
    const app: AppConnection = { socket, appClientId, bound: false }
    session.app = app
    this.log(`App socket connected as ${appClientId}`)

    socket.on('message', data => this.handleMessage(app, data.toString()))
    socket.on('close', () => this.handleClose(app, 'app closed the connection'))
    socket.on('error', error => {
      this.log(`App socket error: ${String(error)}`)
      this.handleClose(app, 'socket error')
    })

    app.bindTimer = setTimeout(() => {
      if (!app.bound) {
        this.log('App socket never completed the DGLAB bind handshake')
        void socket.close(4000, 'bind timeout')
      }
    }, this.options.bindTimeoutMs ?? DEFAULTS.bindTimeoutMs)

    // Initial bind frame: carries the App's own id in clientId and message
    // (the demo frontend reads clientId when targetId is empty).
    await this.write(app, { type: 'bind', clientId: appClientId, targetId: '', message: appClientId })
  }

  private handleMessage(app: AppConnection, raw: string): void {
    let frame: SocketFrame
    try {
      frame = parseFrame(raw)
    } catch (error) {
      this.log(`dropping malformed frame: ${String(error)}`)
      void this.safeWrite(app, { type: 'error', clientId: '', targetId: app.appClientId, message: ERROR_CODES.INVALID_JSON })
      return
    }

    if (frame.type === 'bind') {
      this.handleBind(app, frame)
      return
    }
    if (frame.type === 'heartbeat') return
    if (frame.type === 'break') {
      void this.closeSocket(app)
      return
    }
    if (frame.type === 'error') {
      this.log(`App reported error ${frame.message}`)
      return
    }
    if (!app.bound) {
      this.log(`ignoring ${frame.type} frame before bind`)
      return
    }

    if (frame.message.startsWith('strength-')) {
      try {
        const strength = parseStrengthReport(frame.message)
        this.strength = strength
        this.handlers.onStrength?.(strength)
      } catch (error) {
        this.log(`dropping strength report: ${String(error)}`)
      }
      return
    }
    const feedback = parseFeedback(frame.message)
    if (feedback !== undefined) {
      this.handlers.onFeedback?.(feedback)
      return
    }
    this.log(`ignoring App message ${frame.message.slice(0, 60)}`)
  }

  private handleBind(app: AppConnection, frame: SocketFrame): void {
    const session = this.session
    if (session === undefined || session.app !== app) return
    if (frame.message !== 'DGLAB') {
      this.log(`ignoring bind message ${frame.message}`)
      return
    }
    if (frame.clientId !== session.controlId || frame.targetId !== app.appClientId) {
      this.log(`bind ids mismatch: clientId=${frame.clientId} targetId=${frame.targetId}`)
      void this.safeWrite(app, { type: 'error', clientId: '', targetId: app.appClientId, message: ERROR_CODES.NOT_BOUND })
      return
    }

    app.bound = true
    if (app.bindTimer !== undefined) clearTimeout(app.bindTimer)
    const interval = this.options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs
    app.heartbeatTimer = setInterval(() => {
      void this.safeWrite(app, heartbeatFrame(app.appClientId, session.controlId)).catch(() => {})
    }, interval)
    void this.safeWrite(app, bindOkFrame(session.controlId, app.appClientId))
    this.log(`App ${app.appClientId} bound`)
    this.handlers.onBound?.()
  }

  private handleClose(app: AppConnection, reason: string): void {
    const session = this.session
    if (session?.app !== app) return
    if (app.bindTimer !== undefined) clearTimeout(app.bindTimer)
    if (app.heartbeatTimer !== undefined) clearInterval(app.heartbeatTimer)
    session.app = undefined
    if (app.bound) {
      this.session = undefined
      this.strength = undefined
      this.log(`bound session ended: ${reason}`)
      this.handlers.onDisconnect?.(reason)
    } else {
      this.log(`unbound App socket closed: ${reason}`)
    }
  }

  private async sendCommand(message: string): Promise<void> {
    const session = this.session
    const app = session?.app
    if (session === undefined || app === undefined || !app.bound) {
      throw new CoyoteError('no bound App session', ERROR_CODES.NOT_BOUND)
    }
    await this.write(app, { type: 'msg', clientId: session.controlId, targetId: app.appClientId, message })
  }

  /** Write one frame; a send failure ends the session (fail-safe). */
  private async write(app: AppConnection, frame: SocketFrame): Promise<void> {
    if (app.socket.readyState !== WebSocket.OPEN) {
      throw new CoyoteError('App socket is not open', ERROR_CODES.OFFLINE)
    }
    const json = encodeFrame(frame)
    await new Promise<void>((resolve, reject) => {
      // ws resolves its send callback with null on success.
      app.socket.send(json, error => (error == null ? resolve() : reject(error)))
    }).catch(error => {
      void this.closeSocket(app)
      throw error
    })
  }

  private async safeWrite(app: AppConnection, frame: SocketFrame): Promise<void> {
    try {
      await this.write(app, frame)
    } catch (error) {
      this.log(`write failed: ${String(error)}`)
    }
  }

  private async closeSocket(app: AppConnection): Promise<void> {
    if (app.socket.readyState === WebSocket.OPEN || app.socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>(resolve => {
        app.socket.once('close', resolve)
        app.socket.close(1000, 'dsh-coyote session end')
        setTimeout(resolve, 250).unref?.()
      })
    }
    this.handleClose(app, 'closed by server')
  }

  private log(message: string): void {
    this.handlers.onLog?.(message)
  }
}
