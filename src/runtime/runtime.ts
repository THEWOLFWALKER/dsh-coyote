/**
 * Runtime safety envelope around the transport and the waveform scheduler.
 *
 * Every destructive path is bounded, asymmetric, and fail-safe:
 * - Soft limits: per-channel agent-side caps in the 0..200 strength domain;
 *   the effective cap is min(soft limit, App-reported device limit).
 * - Asymmetric rate limiting: strength increases draw from a refilling token
 *   bucket (burst + rate), decreases are always immediate.
 * - Fail-safe: an App disconnect stops playback and clears both queues.
 * - Session cooldown: a fresh pairing cannot start until the cooldown after
 *   the previous session elapsed (adjustable, 0 disables).
 * - Session and playback duration caps with a hard timer.
 *
 * The App-side hard limit always wins physically: the user can lower it at
 * any time on the phone, and every clamp decision re-reads the latest report.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CoyoteError } from '../errors.ts'
import { ERROR_CODES, type StrengthAction } from '../protocol/frames.ts'
import { encodeWaveSequence, isWaveEntryHex, scaleEntryIntensity } from '../protocol/wave.ts'
import type {
  Channel,
  ChannelSelection,
  ConnectionState,
  DeviceStrength,
  PlayMode,
} from '../types.ts'
import type { SessionInfo } from '../transport/server.ts'
import { CoyoteServer, type CoyoteServerOptions, type GuiConnectionHandler } from '../transport/server.ts'
import { composeWave, type ComposeSpec } from '../waveform/composer.ts'
import {
  BUILT_IN_WAVEFORMS,
  builtInWindows,
  getBuiltIn,
} from '../waveform/library.ts'
import {
  IMPORTED_SUGGESTED_PERCENT,
  loadWaveformDir,
  parseWaveformFile,
  type ImportedWaveform,
} from '../waveform/importer.ts'
import {
  WaveScheduler,
  type PlaySummary,
} from '../waveform/scheduler.ts'

/** Strength domain bounds (0..200 per the socket protocol). */
export const STRENGTH_MIN = 0
export const STRENGTH_MAX = 200

/** Runtime configuration; all fields validated in the constructor. */
export interface CoyoteRuntimeConfig {
  /** WebSocket listen options forwarded to the transport. */
  server?: CoyoteServerOptions
  /** Directory of community waveform files (created on import). */
  waveformDir: string
  /** Agent-side strength cap for channel A (0..200, default 100). */
  softLimitA?: number
  /** Agent-side strength cap for channel B (0..200, default 100). */
  softLimitB?: number
  /** Seconds a new pairing must wait after the last session ended (default 3, 0 disables). */
  sessionCooldownSec?: number
  /** Hard cap on one bound session in seconds (default 3600, 0 disables). */
  maxSessionSec?: number
  /** Hard cap on one playback in seconds (default 600). */
  maxPlaySec?: number
  /** Sustained strength-increase speed in units/second (default 40). */
  increaseRatePerSec?: number
  /** Immediate strength-increase budget in units (default 40). */
  increaseBurst?: number
}

/** Full runtime snapshot for tools and the GUI. */
export interface RuntimeStatus {
  state: ConnectionState
  /** Active pairing session, when one exists. */
  session?: SessionInfo
  /** Latest device-reported strengths, when bound. */
  strength?: DeviceStrength
  /** Effective per-channel caps the runtime enforces right now. */
  effectiveLimitA: number
  effectiveLimitB: number
  /** Whether waveform playback is running on any channel. */
  playing: boolean
  /** Seconds until pairing is allowed again (0 = now). */
  cooldownRemainingSec: number
  /** Library sizes. */
  builtinCount: number
  importedCount: number
}

/** Result of one strength command. */
export interface StrengthResult {
  channels: Channel[]
  /** Values actually sent (post-clamp), per channel. */
  applied: Record<Channel, number>
  /** Values the caller asked for, per channel. */
  requested: Record<Channel, number>
  /** Why values were reduced, when they were. */
  clampedBy?: ('soft-limit' | 'device-limit' | 'rate-limit')[]
}

/** Where a playback takes its entries from. */
export type WaveSource =
  | { kind: 'builtin'; id: string }
  | { kind: 'imported'; name: string }
  | { kind: 'hex'; entries: string[] }
  | { kind: 'spec'; spec: ComposeSpec }

/** One playback request. */
export interface PlayWaveRequest {
  source: WaveSource
  channel: ChannelSelection
  mode: PlayMode
  durationSec: number
  /** Scale waveform intensity bytes by 0..100 percent (default 100). */
  intensityScalePercent?: number
  /** Mirror channel B (100 - x) when playing both. */
  mirrorB?: boolean
}

const DEFAULTS = {
  softLimit: 100,
  sessionCooldownSec: 3,
  maxSessionSec: 3_600,
  maxPlaySec: 600,
  increaseRatePerSec: 40,
  increaseBurst: 40,
}

function assertLimit(value: number, what: string): void {
  if (!Number.isInteger(value) || value < STRENGTH_MIN || value > STRENGTH_MAX) {
    throw new CoyoteError(`${what} must be an integer from ${STRENGTH_MIN} to ${STRENGTH_MAX}`)
  }
}

function assertNonNegative(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) throw new CoyoteError(`${what} must be >= 0`)
}

/** Per-channel token bucket for strength increases. */
class IncreaseLimiter {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst
    this.lastRefill = Date.now()
  }

  /** Refill, then clamp an upward target to what the bucket allows. */
  allow(from: number, to: number): number {
    if (to <= from) return to
    const now = Date.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.rate)
    this.lastRefill = now
    const affordable = Math.floor(this.tokens)
    const allowed = Math.min(to, from + affordable)
    this.tokens -= Math.max(0, allowed - from)
    return allowed
  }

  reset(): void {
    this.tokens = this.burst
    this.lastRefill = Date.now()
  }
}

/** Orchestrates transport, safety envelope, and waveform library. */
export class CoyoteRuntime {
  private readonly server: CoyoteServer
  private readonly scheduler: WaveScheduler
  private readonly imported: ImportedWaveform[] = []
  private readonly limiters: Record<Channel, IncreaseLimiter>
  private readonly baselines: Record<Channel, number> = { A: 0, B: 0 }
  private readonly listeners = new Set<() => void>()
  private cooldownUntil = 0
  private sessionTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly config: CoyoteRuntimeConfig,
    private readonly log: (message: string) => void = () => {},
  ) {
    assertLimit(config.softLimitA ?? DEFAULTS.softLimit, 'softLimitA')
    assertLimit(config.softLimitB ?? DEFAULTS.softLimit, 'softLimitB')
    assertNonNegative(config.sessionCooldownSec ?? DEFAULTS.sessionCooldownSec, 'sessionCooldownSec')
    assertNonNegative(config.maxSessionSec ?? DEFAULTS.maxSessionSec, 'maxSessionSec')
    const maxPlaySec = config.maxPlaySec ?? DEFAULTS.maxPlaySec
    if (!Number.isFinite(maxPlaySec) || maxPlaySec <= 0) throw new CoyoteError('maxPlaySec must be > 0')
    const rate = config.increaseRatePerSec ?? DEFAULTS.increaseRatePerSec
    const burst = config.increaseBurst ?? DEFAULTS.increaseBurst
    if (!Number.isFinite(rate) || rate <= 0) throw new CoyoteError('increaseRatePerSec must be > 0')
    if (!Number.isFinite(burst) || burst <= 0) throw new CoyoteError('increaseBurst must be > 0')

    this.limiters = {
      A: new IncreaseLimiter(rate, burst),
      B: new IncreaseLimiter(rate, burst),
    }
    this.server = new CoyoteServer(config.server ?? {}, {
      onBound: () => this.onBound(),
      onStrength: strength => this.onStrength(strength),
      onDisconnect: reason => this.onDisconnect(reason),
      onLog: message => this.log(`[transport] ${message}`),
    })
    this.scheduler = new WaveScheduler(this.server, {}, error => {
      this.log(`[scheduler] send failed: ${String(error)}`)
    }, () => this.notify())
  }

  /** Start listening and preload the community waveform directory. */
  async start(): Promise<{ host: string; port: number }> {
    const address = await this.server.start()
    for (const wave of await loadWaveformDir(this.config.waveformDir)) {
      this.imported.push(wave)
    }
    if (this.imported.length > 0) this.log(`loaded ${this.imported.length} community waveform(s)`)
    return address
  }

  /** Start (or return the pending) pairing session; enforces the cooldown. */
  async pair(): Promise<SessionInfo> {
    const remaining = this.cooldownRemainingSec()
    if (remaining > 0) {
      throw new CoyoteError(
        `session cooldown active; try again in ${remaining}s`,
        ERROR_CODES.BIND_TIMEOUT,
      )
    }
    const session = await this.server.beginSession()
    this.pairingInfo = session
    this.notify()
    return session
  }

  /**
   * Subscribe to coarse state changes (connection, strength, playback,
   * library). Listeners run on the caller's stack and must not throw.
   * Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Route `/gui` WebSocket connections to the browser-panel bridge. */
  mountGui(handler: GuiConnectionHandler): void {
    this.server.setGuiHandler(handler)
  }

  /** Full snapshot for tools and the GUI. */
  status(): RuntimeStatus {
    const session = this.server.controlId === undefined ? undefined : this.currentSession()
    return {
      state: this.server.state,
      ...(session === undefined ? {} : { session }),
      ...(this.server.strength === undefined ? {} : { strength: this.server.strength }),
      effectiveLimitA: this.effectiveLimit('A'),
      effectiveLimitB: this.effectiveLimit('B'),
      playing: this.scheduler.isPlaying(),
      cooldownRemainingSec: this.cooldownRemainingSec(),
      builtinCount: BUILT_IN_WAVEFORMS.length,
      importedCount: this.imported.length,
    }
  }

  /**
   * Set or adjust strength on one or both channels. Absolute `value` and
   * relative `delta` are mutually exclusive. Everything is clamped to the
   * effective limit and the increase limiter; decreases always pass.
   */
  async setStrength(
    selection: ChannelSelection,
    request: { value?: number; delta?: number },
  ): Promise<StrengthResult> {
    const channels = this.targets(selection)
    const strength = this.server.strength
    const requested: Partial<Record<Channel, number>> = {}
    const applied: Partial<Record<Channel, number>> = {}
    const clampedBy = new Set<'soft-limit' | 'device-limit' | 'rate-limit'>()

    if (request.value === undefined && request.delta === undefined) {
      throw new CoyoteError('setStrength needs either value or delta')
    }
    if (request.value !== undefined && (!Number.isInteger(request.value) || request.value < STRENGTH_MIN || request.value > STRENGTH_MAX)) {
      throw new CoyoteError(`strength value must be an integer from ${STRENGTH_MIN} to ${STRENGTH_MAX}`)
    }
    if (request.delta !== undefined && (!Number.isInteger(request.delta) || request.delta < -STRENGTH_MAX || request.delta > STRENGTH_MAX)) {
      throw new CoyoteError(`strength delta must be an integer within ±${STRENGTH_MAX}`)
    }

    for (const channel of channels) {
      const current = strength === undefined ? this.baselines[channel] : channel === 'A' ? strength.a : strength.b
      let target: number
      if (request.value !== undefined) {
        target = request.value
      } else {
        if (strength === undefined) {
          throw new CoyoteError('relative strength change needs a bound App; use an absolute value')
        }
        target = current + (request.delta ?? 0)
      }

      const soft = channel === 'A' ? this.softLimitA : this.softLimitB
      const device = strength === undefined ? STRENGTH_MAX : channel === 'A' ? strength.limitA : strength.limitB
      const cap = Math.min(soft, device)
      if (target > soft) clampedBy.add('soft-limit')
      if (target > device) clampedBy.add('device-limit')
      target = Math.min(target, cap)
      target = Math.max(STRENGTH_MIN, target)

      const limited = this.limiters[channel]!.allow(this.baselines[channel]!, target)
      if (limited < target) clampedBy.add('rate-limit')
      target = limited

      requested[channel] = Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX,
        request.value !== undefined ? request.value : current + (request.delta ?? 0)))
      applied[channel] = target
    }

    for (const channel of channels) {
      const action: StrengthAction = 2
      await this.server.sendStrength(channel, action, applied[channel]!)
      this.baselines[channel] = applied[channel]!
    }
    this.notify()

    return {
      channels,
      applied: applied as Record<Channel, number>,
      requested: requested as Record<Channel, number>,
      ...(clampedBy.size === 0 ? {} : { clampedBy: [...clampedBy].sort() }),
    }
  }

  /** Resolve a source, validate it, and hand it to the scheduler. */
  async playWave(request: PlayWaveRequest): Promise<PlaySummary & { entryCount: number }> {
    const maxPlaySec = this.config.maxPlaySec ?? DEFAULTS.maxPlaySec
    if (!Number.isFinite(request.durationSec) || request.durationSec <= 0) {
      throw new CoyoteError('durationSec must be > 0')
    }
    const durationSec = Math.min(request.durationSec, maxPlaySec)
    if (durationSec !== request.durationSec) {
      this.log(`playback duration capped from ${request.durationSec}s to ${maxPlaySec}s`)
    }

    const entries = this.resolveEntries(request.source)
    const scale = request.intensityScalePercent ?? 100
    const scaled = scale === 100 ? entries : entries.map(entry => scaleEntryIntensity(entry, scale))

    const summary = await this.scheduler.play({
      entries: scaled,
      channel: request.channel,
      mode: request.mode,
      durationSec,
      ...(request.mirrorB === undefined ? {} : { mirrorB: request.mirrorB }),
    })
    this.notify()
    return { ...summary, entryCount: entries.length }
  }

  /** Stop waveform playback but keep channel strength as-is. */
  async stopWave(): Promise<void> {
    await this.scheduler.stopAll()
    this.notify()
  }

  /** Emergency stop: zero both strengths and clear both waveform queues. */
  async panicStop(): Promise<void> {
    await this.scheduler.stopAll()
    if (this.server.isBound()) {
      await this.server.sendStrength('A', 2, STRENGTH_MIN).catch(error => this.log(`panic A failed: ${String(error)}`))
      await this.server.sendStrength('B', 2, STRENGTH_MIN).catch(error => this.log(`panic B failed: ${String(error)}`))
    }
    this.baselines.A = 0
    this.baselines.B = 0
    this.notify()
  }

  /** End the pairing session (cooldown applies afterwards). */
  async endSession(): Promise<void> {
    if (this.sessionTimer !== undefined) clearTimeout(this.sessionTimer)
    await this.panicStop()
    await this.server.endSession()
    this.armCooldown()
    this.notify()
  }

  /** List every playable waveform. */
  listWaveforms(): Array<{ source: 'builtin' | 'imported'; id: string; name: string; description: string; suggestedIntensityPercent: number; entryCount?: number }> {
    const builtins = BUILT_IN_WAVEFORMS.map(wave => ({
      source: 'builtin' as const,
      id: wave.id,
      name: wave.name,
      description: `${wave.description} (${wave.nameZh})`,
      suggestedIntensityPercent: wave.suggestedIntensityPercent,
    }))
    const importedWaves = this.imported.map(wave => ({
      source: 'imported' as const,
      id: wave.name,
      name: wave.name,
      description: `community import from ${wave.source ?? 'inline'}`,
      suggestedIntensityPercent: IMPORTED_SUGGESTED_PERCENT,
      entryCount: wave.entries.length,
    }))
    return [...builtins, ...importedWaves]
  }

  /** Import community waveforms from text and persist them to the library dir. */
  async importWaveform(text: string, fileName: string): Promise<ImportedWaveform[]> {
    const waves = parseWaveformFile(text, fileName)
    await mkdir(this.config.waveformDir, { recursive: true })
    for (const wave of waves) {
      const safe = wave.name.replace(/[^\w\u4e00-\u9fa5 -]/g, '_').slice(0, 64) || 'wave'
      await writeFile(join(this.config.waveformDir, `${safe}.pulses`), JSON.stringify([{ name: wave.name, pulseData: wave.entries }], undefined, 2))
      // Re-importing a name replaces the in-memory entry so the list cannot
      // inflate with duplicates (the file on disk is already overwritten).
      const existing = this.imported.findIndex(item => item.name === wave.name)
      const record = { ...wave, source: `${safe}.pulses` }
      if (existing >= 0) this.imported[existing] = record
      else this.imported.push(record)
    }
    this.log(`imported ${waves.length} waveform(s)`)
    this.notify()
    return waves
  }

  /** Permanent teardown for plugin unload. */
  async dispose(): Promise<void> {
    if (this.sessionTimer !== undefined) clearTimeout(this.sessionTimer)
    await this.panicStop()
    await this.server.dispose()
  }

  private resolveEntries(source: WaveSource): string[] {
    if (source.kind === 'builtin') {
      const wave = getBuiltIn(source.id)
      if (wave === undefined) {
        throw new CoyoteError(`unknown built-in waveform: ${source.id}`)
      }
      const windows = builtInWindows(source.id)
      if (windows.length === 0) throw new CoyoteError(`built-in waveform is empty: ${source.id}`)
      return encodeWaveSequence(windows)
    }
    if (source.kind === 'imported') {
      const wave = this.imported.find(item => item.name.toLowerCase() === source.name.trim().toLowerCase())
      if (wave === undefined) throw new CoyoteError(`unknown imported waveform: ${source.name}`)
      return [...wave.entries]
    }
    if (source.kind === 'hex') {
      if (source.entries.length === 0) throw new CoyoteError('hex waveform needs at least one entry')
      return source.entries.map(entry => {
        if (!isWaveEntryHex(entry)) throw new CoyoteError(`invalid waveform entry (need 16 hex characters): ${entry}`)
        return entry.toLowerCase()
      })
    }
    const composed = composeWave(source.spec)
    return encodeWaveSequence(composed.windows)
  }

  private async onBound(): Promise<void> {
    this.log('App bound; session timer armed')
    // Defensive: a stale timer from an earlier bind on this session must not
    // survive into a fresh one.
    if (this.sessionTimer !== undefined) clearTimeout(this.sessionTimer)
    this.limiters.A.reset()
    this.limiters.B.reset()
    const maxSessionSec = this.config.maxSessionSec ?? DEFAULTS.maxSessionSec
    if (maxSessionSec > 0) {
      this.sessionTimer = setTimeout(() => {
        this.log(`max session length (${maxSessionSec}s) reached; stopping everything`)
        void this.endSession()
      }, maxSessionSec * 1000)
    }
    this.notify()
  }

  private onStrength(strength: DeviceStrength): void {
    this.baselines.A = strength.a
    this.baselines.B = strength.b
    this.notify()
  }

  private async onDisconnect(reason: string): Promise<void> {
    this.log(`fail-safe: ${reason}; stopping playback`)
    await this.scheduler.stopAll().catch(error => this.log(`fail-safe stop failed: ${String(error)}`))
    this.baselines.A = 0
    this.baselines.B = 0
    if (this.sessionTimer !== undefined) clearTimeout(this.sessionTimer)
    this.armCooldown()
    this.notify()
  }

  /** Fan out a coarse change notification; listener errors are contained. */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.log(`change listener failed: ${String(error)}`)
      }
    }
  }

  private armCooldown(): void {
    const cooldown = this.config.sessionCooldownSec ?? DEFAULTS.sessionCooldownSec
    this.cooldownUntil = Date.now() + cooldown * 1000
  }

  private cooldownRemainingSec(): number {
    return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000))
  }

  private currentSession(): SessionInfo | undefined {
    const controlId = this.server.controlId
    if (controlId === undefined) return undefined
    // Keep the last pairing payload after bind so the GUI stays informative.
    return this.pairingInfo ?? { controlId, qrPayload: '', qrDataUrl: '' }
  }

  private pairingInfo?: SessionInfo

  private get softLimitA(): number {
    return this.config.softLimitA ?? DEFAULTS.softLimit
  }

  private get softLimitB(): number {
    return this.config.softLimitB ?? DEFAULTS.softLimit
  }

  private effectiveLimit(channel: Channel): number {
    const strength = this.server.strength
    const device = strength === undefined ? STRENGTH_MAX : channel === 'A' ? strength.limitA : strength.limitB
    return Math.min(channel === 'A' ? this.softLimitA : this.softLimitB, device)
  }

  private targets(selection: ChannelSelection): Channel[] {
    if (!this.server.isBound()) throw new CoyoteError('no bound App session', ERROR_CODES.NOT_BOUND)
    return selection === 'both' ? ['A', 'B'] : [selection]
  }
}
