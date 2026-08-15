/**
 * Auto-stim trigger engine: the only layer allowed to command the device on
 * behalf of events.
 *
 * Gate chain, in order (a pulse fires only if every gate passes):
 *   rule enabled → armed → not busy → cooldown elapsed → App bound
 * Events that fail a gate are dropped and counted, never queued — a backlog
 * of punishment must not build up into a battery.
 *
 * Strength semantics — absolute transient pulse: the channel strength is
 * boosted to min(rule intensity, maxIntensity) (the runtime further clamps to
 * soft/device limits and the increase limiter), the waveform plays once, then
 * the pre-pulse strength is restored best-effort. This works from a freshly
 * paired device at strength 0 and never depends on the user's manual knob.
 *
 * Every path is fail-soft: the engine catches its own failures and logs them,
 * because a throw escaping into a cordis listener would poison the host.
 */

import type { Channel, ChannelSelection } from '../types.ts'
import type { CoyoteRuntime, WaveSource } from '../runtime/runtime.ts'
import { getBuiltIn } from '../waveform/library.ts'
import { CoyoteError } from '../errors.ts'
import type { AutoStimConfig, AutoStimEvent, AutoStimRule } from './rules.ts'

/** Extra slack after playback before restoring, covering scheduler lag. */
const RESTORE_MARGIN_MS = 500

/** Snapshot for tools, the GUI bridge, and tests. */
export interface AutoStimStatus {
  enabled: true
  /** Runtime arm switch (GUI toggle); disarmed drops every event silently. */
  armed: boolean
  maxIntensity: number
  cooldownSec: number
  /** A pulse (including its restore) is running right now. */
  inFlight: boolean
  fired: number
  skipped: number
  lastEvent?: AutoStimEvent
  /** `<event>:<reason>` of the most recent dropped event. */
  lastSkipReason?: string
  lastFiredAt?: number
  cooldownRemainingSec: number
}

export class AutoStimEngine {
  private armed = true
  private inFlight = false
  private cooldownUntil = 0
  private fired = 0
  private skipped = 0
  private lastEvent?: AutoStimEvent
  private lastSkipReason?: string
  private lastFiredAt?: number
  private restoreTimer: ReturnType<typeof setTimeout> | undefined
  private restoreResolve: (() => void) | undefined
  /** The pulse currently between boost and restore; set before any device command. */
  private activePulse: { selection: ChannelSelection; snapshot: Record<Channel, number> } | undefined
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly runtime: CoyoteRuntime,
    private readonly config: AutoStimConfig,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Entry point from the attach layer; synchronous, never throws. */
  handle(event: AutoStimEvent): void {
    if (this.disposed) return
    const rule = this.config.rules[event]
    if (rule === undefined || !rule.enabled) return
    if (!this.armed) return this.skip(event, 'disarmed')
    if (this.inFlight) return this.skip(event, 'busy')
    const now = Date.now()
    if (now < this.cooldownUntil) return this.skip(event, 'cooldown')
    if (this.runtime.status().state !== 'bound') return this.skip(event, 'not-bound')

    this.inFlight = true
    this.fired += 1
    this.lastEvent = event
    this.lastFiredAt = now
    this.cooldownUntil = now + this.config.cooldownSec * 1000
    this.notify()
    this.fire(rule, event)
      .catch(error => this.log(`auto-stim ${event} failed: ${String(error)}`))
      .finally(() => {
        this.inFlight = false
        this.notify()
      })
  }

  /** GUI arm switch. A pulse already in flight still finishes (including restore). */
  setArmed(armed: boolean): void {
    if (this.armed === armed) return
    this.armed = armed
    this.log(`auto-stim ${armed ? 'armed' : 'disarmed'}`)
    this.notify()
  }

  /** Coarse change notification for the GUI bridge; returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  status(): AutoStimStatus {
    return {
      enabled: true,
      armed: this.armed,
      maxIntensity: this.config.maxIntensity,
      cooldownSec: this.config.cooldownSec,
      inFlight: this.inFlight,
      fired: this.fired,
      skipped: this.skipped,
      ...(this.lastEvent === undefined ? {} : { lastEvent: this.lastEvent }),
      ...(this.lastSkipReason === undefined ? {} : { lastSkipReason: this.lastSkipReason }),
      ...(this.lastFiredAt === undefined ? {} : { lastFiredAt: this.lastFiredAt }),
      cooldownRemainingSec: Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000)),
    }
  }

  /**
   * Permanent teardown: cancel the pending restore timer, cut an in-flight
   * pulse short (stopWave makes playWave return early), and restore the
   * pre-pulse strength immediately — teardown must never leave a boosted
   * level behind, whatever phase the pulse was in.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.restoreTimer !== undefined) {
      clearTimeout(this.restoreTimer)
      this.restoreTimer = undefined
    }
    const resolve = this.restoreResolve
    this.restoreResolve = undefined
    resolve?.()
    const active = this.activePulse
    this.activePulse = undefined
    if (active !== undefined && this.runtime.status().state === 'bound') {
      void this.runtime.stopWave()
        .then(() => this.restore(active.selection, active.snapshot))
        .then(() => this.log(`auto-stim restored to A=${active.snapshot.A} B=${active.snapshot.B}`))
        .catch(error => this.log(`auto-stim teardown restore failed: ${String(error)}`))
    }
  }

  private async fire(rule: AutoStimRule, event: AutoStimEvent): Promise<void> {
    const status = this.runtime.status()
    const snapshot: Record<Channel, number> = {
      A: status.strength?.a ?? 0,
      B: status.strength?.b ?? 0,
    }
    // Recorded before the first device command so dispose() can restore from
    // any phase of the pulse below.
    this.activePulse = { selection: rule.channel, snapshot }
    const target = Math.min(rule.intensity, this.config.maxIntensity)
    this.log(`auto-stim ${event}: ${rule.waveform} @ ${target} for ${rule.durationSec}s on ${rule.channel}`)

    // Resolve before any device command: a typo'd waveform must abort the
    // pulse without ever touching the strength (no ghost boost).
    const source = this.resolveWaveform(rule.waveform)

    try {
      const boost = await this.runtime.setStrength(rule.channel, { value: target })
      if (boost.applied.A !== target || boost.applied.B !== target) {
        this.log(`auto-stim boost clamped: ${JSON.stringify(boost)}`)
      }

      await this.runtime.playWave({
        source,
        channel: rule.channel,
        mode: 'once',
        durationSec: rule.durationSec,
      })
    } catch (error) {
      // The boost may already be live; restore best-effort before surfacing
      // the failure so a mid-pulse error never strands a raised level.
      if (this.config.restoreBaseline && !this.disposed) {
        try {
          await this.restore(rule.channel, snapshot)
          this.log(`auto-stim restored to A=${snapshot.A} B=${snapshot.B} after failure`)
        } catch (restoreError) {
          this.log(`auto-stim post-failure restore failed: ${String(restoreError)}`)
        }
      }
      this.activePulse = undefined
      throw error
    }

    if (!this.config.restoreBaseline || this.disposed) {
      // dispose() already owns the restore for the disposed case.
      this.activePulse = undefined
      return
    }
    await this.waitRestore(rule.durationSec * 1000 + RESTORE_MARGIN_MS)
    this.activePulse = undefined
    if (this.disposed) return
    try {
      await this.restore(rule.channel, snapshot)
      this.log(`auto-stim restored to A=${snapshot.A} B=${snapshot.B}`)
    } catch (error) {
      this.log(`auto-stim restore failed: ${String(error)}`)
    }
  }

  /**
   * Resolve a rule's waveform name to a play source: built-in id first, then
   * imported waveform name (both case-insensitive). A miss throws, which the
   * handle() catch turns into a log line — a typo'd rule must not crash the
   * host, but it must be visible in the log.
   */
  private resolveWaveform(name: string): WaveSource {
    const wanted = name.trim().toLowerCase()
    if (getBuiltIn(wanted) !== undefined) return { kind: 'builtin', id: wanted }
    const imported = this.runtime.listWaveforms().find(
      wave => wave.source === 'imported' && wave.id.toLowerCase() === wanted,
    )
    if (imported !== undefined) return { kind: 'imported', name: imported.name }
    throw new CoyoteError(`auto-stim waveform "${name}" is neither built-in nor imported`)
  }

  private async restore(selection: ChannelSelection, snapshot: Record<Channel, number>): Promise<void> {
    if (selection === 'both') {
      if (snapshot.A === snapshot.B) {
        await this.runtime.setStrength('both', { value: snapshot.A })
        return
      }
      await this.runtime.setStrength('A', { value: snapshot.A })
      await this.runtime.setStrength('B', { value: snapshot.B })
      return
    }
    await this.runtime.setStrength(selection, { value: snapshot[selection] })
  }

  private waitRestore(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      this.restoreResolve = resolve
      this.restoreTimer = setTimeout(() => {
        this.restoreTimer = undefined
        this.restoreResolve = undefined
        resolve()
      }, ms)
    })
  }

  private skip(event: AutoStimEvent, reason: string): void {
    this.skipped += 1
    this.lastSkipReason = `${event}:${reason}`
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.log(`auto-stim listener failed: ${String(error)}`)
      }
    }
  }
}
