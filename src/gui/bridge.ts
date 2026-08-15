/**
 * Browser-panel bridge: the `/gui` WebSocket endpoint of the Coyote server.
 *
 * The panel is a second-class terminal: unlike the DG-LAB App it never talks
 * to the device directly — every op is routed through the same CoyoteRuntime
 * safety envelope as the model tools (soft limits, rate limiting, fail-safe,
 * playback caps), so GUI and agent cannot bypass each other's bounds.
 *
 * Wire protocol (one JSON object per text frame, both directions):
 *
 * Client → server ops:
 *   {op:'hello'}                                              greet; replies status + waveforms
 *   {op:'pair'} | {op:'end'}                                  pairing lifecycle
 *   {op:'strength', channel:'A'|'B'|'both', value?|delta?}    set strength (runtime clamps)
 *   {op:'play', waveform?|spec?|hex_entries?, channel?,       start a playback
 *        mode?, duration_sec?, intensity_percent?, mirror?}
 *   {op:'stop'} | {op:'panic'}                                stop waves / emergency stop
 *   {op:'auto', armed:boolean}                                arm/disarm auto-stim (when enabled)
 *   {op:'list'}                                               waveforms list refresh
 *   {op:'import', text, file_name?}                           import community waveforms
 *
 * Server → client events (broadcast to every GUI socket):
 *   {event:'status', status}       full RuntimeStatus snapshot (+ autoStim when enabled)
 *   {event:'waveforms', waveforms} full library list (on hello/list/import)
 *   {event:'ack', op}              op completed
 *   {event:'error', message}       op failed (cooldown active, not bound, bad input…)
 */

import type { WebSocket } from 'ws'
import { CoyoteError } from '../errors.ts'
import type { AutoStimEngine } from '../auto-stim/engine.ts'
import type { ChannelSelection } from '../types.ts'
import type { CoyoteRuntime, WaveSource } from '../runtime/runtime.ts'
import type { ComposeSpec } from '../waveform/composer.ts'
import { getBuiltIn } from '../waveform/library.ts'

const CHANNELS = new Set(['A', 'B', 'both'])

/** Import payload cap: a paste larger than this is rejected before parsing. */
const MAX_IMPORT_CHARS = 2_000_000

/** Unknown JSON op or malformed frame text. */
class OpError extends CoyoteError {}

interface StrengthOp {
  op: 'strength'
  channel?: unknown
  value?: unknown
  delta?: unknown
}

interface PlayOp {
  op: 'play'
  waveform?: unknown
  spec?: unknown
  hex_entries?: unknown
  channel?: unknown
  mode?: unknown
  duration_sec?: unknown
  intensity_percent?: unknown
  mirror?: unknown
}

interface ImportOp {
  op: 'import'
  text?: unknown
  file_name?: unknown
}

type GuiOp = StrengthOp | PlayOp | ImportOp | { op: string; [key: string]: unknown }

function asChannel(value: unknown): ChannelSelection {
  if (typeof value !== 'string' || !CHANNELS.has(value)) {
    throw new OpError(`channel must be one of A, B, both (got ${JSON.stringify(value)})`)
  }
  return value as ChannelSelection
}

function asInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OpError(`${what} must be an integer`)
  }
  return value
}

function asDuration(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new OpError(`${what} must be a positive number`)
  }
  return value
}

/**
 * One bridge instance serves every connected panel. `broadcast` pushes the
 * same snapshot to all sockets, so two open panels never disagree. When an
 * auto-stim engine is present its status rides along on every snapshot and
 * its change notifications trigger broadcasts too.
 */
export class GuiBridge {
  private readonly sockets = new Set<WebSocket>()
  private unsubscribe: (() => void) | undefined
  private unsubscribeAutoStim: (() => void) | undefined
  private lastImportedCount = -1

  constructor(
    private readonly runtime: CoyoteRuntime,
    private readonly autoStim?: AutoStimEngine,
  ) {}

  /** Accept one panel socket; subscribes to runtime/auto-stim changes once globally. */
  handleConnection(socket: WebSocket): void {
    this.sockets.add(socket)
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.runtime.subscribe(() => this.onRuntimeChange())
    }
    if (this.unsubscribeAutoStim === undefined && this.autoStim !== undefined) {
      this.unsubscribeAutoStim = this.autoStim.subscribe(() => this.onRuntimeChange())
    }
    socket.on('message', raw => {
      void this.dispatch(socket, raw.toString()).catch(error => {
        this.send(socket, { event: 'error', message: errorMessage(error) })
      })
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      if (this.sockets.size === 0) {
        if (this.unsubscribe !== undefined) {
          this.unsubscribe()
          this.unsubscribe = undefined
        }
        if (this.unsubscribeAutoStim !== undefined) {
          this.unsubscribeAutoStim()
          this.unsubscribeAutoStim = undefined
        }
      }
    })
    socket.on('error', () => this.sockets.delete(socket))
    this.send(socket, { event: 'status', status: this.composeStatus() })
    this.send(socket, { event: 'waveforms', waveforms: this.runtime.listWaveforms() })
  }

  /** Drop every panel connection (plugin teardown). */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.unsubscribeAutoStim?.()
    this.unsubscribeAutoStim = undefined
    for (const socket of [...this.sockets]) socket.close(1001, 'bridge disposed')
    this.sockets.clear()
  }

  /** Push a fresh snapshot to every connected panel (auto-stim changes use this). */
  broadcast(): void {
    this.onRuntimeChange()
  }

  /** RuntimeStatus plus the auto-stim block when the feature is enabled. */
  private composeStatus(): Record<string, unknown> {
    return {
      ...this.runtime.status(),
      ...(this.autoStim === undefined ? {} : { autoStim: this.autoStim.status() }),
    }
  }

  private async dispatch(socket: WebSocket, raw: string): Promise<void> {
    let op: GuiOp
    try {
      op = JSON.parse(raw) as GuiOp
    } catch {
      throw new OpError('frame is not valid JSON')
    }
    if (typeof op !== 'object' || op === null || typeof op.op !== 'string') {
      throw new OpError('frame needs an "op" string')
    }

    switch (op.op) {
      case 'hello':
        this.send(socket, { event: 'status', status: this.composeStatus() })
        this.send(socket, { event: 'waveforms', waveforms: this.runtime.listWaveforms() })
        return
      case 'pair':
        await this.runtime.pair()
        this.send(socket, { event: 'ack', op: 'pair' })
        break
      case 'end':
        await this.runtime.endSession()
        this.send(socket, { event: 'ack', op: 'end' })
        break
      case 'strength':
        await this.runtime.setStrength(asChannel(op.channel), {
          ...(op.value === undefined ? {} : { value: asInt(op.value, 'value') }),
          ...(op.delta === undefined ? {} : { delta: asInt(op.delta, 'delta') }),
        })
        this.send(socket, { event: 'ack', op: 'strength' })
        break
      case 'play':
        await this.runtime.playWave(this.playRequest(op as PlayOp))
        this.send(socket, { event: 'ack', op: 'play' })
        break
      case 'stop':
        await this.runtime.stopWave()
        this.send(socket, { event: 'ack', op: 'stop' })
        break
      case 'panic':
        await this.runtime.panicStop()
        this.send(socket, { event: 'ack', op: 'panic' })
        break
      case 'auto':
        if (this.autoStim === undefined) {
          throw new OpError('auto-stim is disabled in config (autoStim.enabled)')
        }
        if (typeof op.armed !== 'boolean') throw new OpError('auto needs a boolean "armed"')
        this.autoStim.setArmed(op.armed)
        this.send(socket, { event: 'ack', op: 'auto' })
        break
      case 'list':
        this.send(socket, { event: 'waveforms', waveforms: this.runtime.listWaveforms() })
        return
      case 'import': {
        const text = (op as ImportOp).text
        if (typeof text !== 'string' || text.trim().length === 0) {
          throw new OpError('import needs the file content in "text"')
        }
        if (text.length > MAX_IMPORT_CHARS) {
          throw new OpError(`import text exceeds ${MAX_IMPORT_CHARS} characters`)
        }
        const fileName = (op as ImportOp).file_name
        await this.runtime.importWaveform(text, typeof fileName === 'string' && fileName.length > 0 ? fileName : 'gui-import.pulses')
        this.send(socket, { event: 'waveforms', waveforms: this.runtime.listWaveforms() })
        this.send(socket, { event: 'ack', op: 'import' })
        break
      }
      default:
        throw new OpError(`unknown op "${(op as { op: string }).op}"`)
    }

    // Ops that mutate state always answer with a fresh snapshot too.
    this.send(socket, { event: 'status', status: this.composeStatus() })
  }

  private playRequest(op: PlayOp): {
    source: WaveSource
    channel: ChannelSelection
    mode: 'once' | 'loop'
    durationSec: number
    intensityScalePercent?: number
    mirrorB?: boolean
  } {
    const waveform = typeof op.waveform === 'string' ? op.waveform : undefined
    const hasSpec = op.spec !== undefined
    const hasHex = op.hex_entries !== undefined
    const picked = [waveform, hasSpec, hasHex].filter(Boolean).length
    if (picked !== 1) throw new OpError('pass exactly one of waveform, spec, or hex_entries')

    let source: WaveSource
    if (waveform !== undefined) {
      const wanted = waveform.trim().toLowerCase()
      if (getBuiltIn(wanted) !== undefined) {
        source = { kind: 'builtin', id: wanted }
      } else {
        const imported = this.runtime.listWaveforms().find(
          wave => wave.source === 'imported' && wave.id.toLowerCase() === wanted,
        )
        if (imported === undefined) throw new OpError(`unknown waveform "${waveform}"`)
        source = { kind: 'imported', name: imported.name }
      }
    } else if (hasSpec) {
      // composeWave validates the spec shape before anything is sent.
      source = { kind: 'spec', spec: op.spec as ComposeSpec }
    } else {
      const entries = op.hex_entries
      if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) {
        throw new OpError('hex_entries must be an array of strings')
      }
      source = { kind: 'hex', entries: entries as string[] }
    }

    const mode = op.mode === undefined ? 'once' : op.mode
    if (mode !== 'once' && mode !== 'loop') throw new OpError('mode must be "once" or "loop"')

    return {
      source,
      channel: op.channel === undefined ? 'A' : asChannel(op.channel),
      mode,
      durationSec: op.duration_sec === undefined ? 30 : asDuration(op.duration_sec, 'duration_sec'),
      ...(op.intensity_percent === undefined ? {} : { intensityScalePercent: asInt(op.intensity_percent, 'intensity_percent') }),
      ...(op.mirror === undefined ? {} : { mirrorB: op.mirror === true }),
    }
  }

  /** Push the new snapshot to every panel whenever the runtime or engine changed. */
  private onRuntimeChange(): void {
    const status = this.composeStatus()
    for (const socket of [...this.sockets]) {
      this.send(socket, { event: 'status', status })
    }
    const importedCount = this.runtime.listWaveforms().length
    if (importedCount !== this.lastImportedCount) {
      this.lastImportedCount = importedCount
      const waveforms = this.runtime.listWaveforms()
      for (const socket of [...this.sockets]) {
        this.send(socket, { event: 'waveforms', waveforms })
      }
    }
  }

  private send(socket: WebSocket, event: Record<string, unknown>): void {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(event), error => {
      if (error != null) this.sockets.delete(socket)
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
