/**
 * Waveform playback scheduler: segments entries under the protocol's 100-cap
 * (70 with margin), keeps the App queue fed slightly ahead of playback, and
 * caps every play with a hard duration timer.
 *
 * Segmentation values follow the ecosystem convention (openclaw-plugin-dg-lab
 * sends 70 entries per message; the official limit is 100 and the App queue
 * holds 500). The clear-then-pause-then-send sequence follows the official
 * tip in socket/README.md (clear may arrive after data under network jitter).
 */

import type { Channel, ChannelSelection, PlayMode } from '../types.ts'

/** Transport face the scheduler needs (implemented by the WS server). */
export interface WaveTransport {
  /** Send one pulse segment to one channel. */
  sendPulse(channel: Channel, entries: readonly string[]): Promise<void>
  /** Clear one channel's pending waveform queue. */
  clearPulse(channel: Channel): Promise<void>
}

/** One playback request. */
export interface PlayRequest {
  /** Full hex entry list; length may exceed the segment size. */
  entries: string[]
  /** Target channels. */
  channel: ChannelSelection
  /** once plays the list once; loop repeats it until the duration cap. */
  mode: PlayMode
  /** Hard cap in seconds; playback always ends by then. */
  durationSec: number
  /** Mirror channel B intensity (100 - x) when playing both channels. */
  mirrorB?: boolean
}

/** Result of a started playback. */
export interface PlaySummary {
  /** Channels actually driven. */
  channels: Channel[]
  mode: PlayMode
  durationSec: number
  /** Number of wire segments scheduled for the first pass. */
  segments: number
}

/** Scheduler options; defaults are the protocol-derived constants. */
export interface SchedulerOptions {
  /** Entries per wire message (default 70, official cap 100). */
  segmentSize?: number
  /** Send the next segment this many ms before playback would starve. */
  leadMs?: number
  /** Pause after clear before sending new data (official tip). */
  clearGapMs?: number
  /** Floor for inter-segment delays. */
  minIntervalMs?: number
}

const DEFAULTS = {
  segmentSize: 70,
  leadMs: 200,
  clearGapMs: 150,
  minIntervalMs: 50,
}

interface ChannelRun {
  token: symbol
  timers: Set<ReturnType<typeof setTimeout>>
}

/** Invert the intensity axis of one hex entry (bytes 4-7). */
export function mirrorEntry(entry: string): string {
  const bytes: string[] = []
  for (let i = 0; i < 16; i += 2) {
    if (i >= 8) {
      const value = Number.parseInt(entry.slice(i, i + 2), 16)
      bytes.push(Math.max(0, Math.min(100, 100 - value)).toString(16).padStart(2, '0'))
    } else {
      bytes.push(entry.slice(i, i + 2))
    }
  }
  return bytes.join('')
}

/** Segment a play through the transport with looping and hard duration caps. */
export class WaveScheduler {
  private readonly runs = new Map<Channel, ChannelRun>()
  private disposing = false

  constructor(
    private readonly transport: WaveTransport,
    private readonly options: SchedulerOptions = {},
    private readonly reportFailure: (error: unknown) => void = () => {},
    /** Called once whenever the last active run ends (playback went idle). */
    private readonly onIdle: () => void = () => {},
  ) {}

  /** Start one playback, replacing whatever ran on the target channels. */
  async play(request: PlayRequest): Promise<PlaySummary> {
    if (this.disposing) throw new Error('waveform scheduler is shutting down')
    if (request.entries.length === 0) throw new Error('playback needs at least one entry')
    if (!(request.durationSec > 0)) throw new Error('durationSec must be positive')

    const channels: Channel[] = request.channel === 'both' ? ['A', 'B'] : [request.channel]
    for (const channel of channels) {
      this.cancelChannel(channel)
      await this.transport.clearPulse(channel)
    }
    await delay(this.resolved().clearGapMs)

    const token = Symbol('coyote-play')
    for (const channel of channels) {
      const run: ChannelRun = { token, timers: new Set() }
      this.runs.set(channel, run)
      const entries = channel === 'B' && request.mirrorB === true
        ? request.entries.map(mirrorEntry)
        : request.entries
      this.scheduleChannel(channel, run, entries, request.mode, request.durationSec * 1000)
    }
    return {
      channels,
      mode: request.mode,
      durationSec: request.durationSec,
      segments: Math.ceil(request.entries.length / this.resolved().segmentSize),
    }
  }

  /** Stop every channel: cancel timers, clear queues. */
  async stopAll(): Promise<void> {
    for (const channel of ['A', 'B'] as const) {
      this.cancelChannel(channel)
    }
    try {
      await this.transport.clearPulse('A')
      await this.transport.clearPulse('B')
    } catch (error) {
      this.reportFailure(error)
    }
  }

  /** Whether any channel has an active run. */
  isPlaying(): boolean {
    return this.runs.size > 0
  }

  /** Reject new plays, stop everything. Used on plugin teardown. */
  async dispose(): Promise<void> {
    this.disposing = true
    await this.stopAll()
  }

  private scheduleChannel(
    channel: Channel,
    run: ChannelRun,
    entries: string[],
    mode: PlayMode,
    durationMs: number,
  ): void {
    const { segmentSize, leadMs, minIntervalMs } = this.resolved()
    const segments: string[][] = []
    for (let i = 0; i < entries.length; i += segmentSize) {
      segments.push(entries.slice(i, i + segmentSize))
    }
    const startedAt = Date.now()

    /**
     * End this channel's run. Also drops whatever still sits in the device's
     * waveform queue (it may hold up to one segment, ~7s): a duration cap
     * or a replaced playback must stop output at once, not drain the tail.
     */
    const finish = (): void => {
      if (this.runs.get(channel)?.token === run.token) this.runs.delete(channel)
      void this.transport.clearPulse(channel).catch(() => {
        // Not bound anymore: the device is gone and the queue with it.
      })
      if (this.runs.size === 0) this.onIdle()
    }

    const sendSegment = (index: number): void => {
      if (this.runs.get(channel)?.token !== run.token) return
      if (Date.now() - startedAt >= durationMs) {
        finish()
        return
      }
      const segment = segments[index]!
      void this.transport.sendPulse(channel, segment).catch(error => {
        this.reportFailure(error)
        finish()
      })
      const next = mode === 'loop' ? (index + 1) % segments.length : index + 1
      const lastPass = mode === 'once' && next >= segments.length
      if (lastPass) {
        const elapsedBudget = durationMs - (Date.now() - startedAt)
        const tail = Math.max(minIntervalMs, elapsedBudget)
        const endTimer = setTimeout(() => finish(), tail)
        run.timers.add(endTimer)
        return
      }
      const segmentMs = segment.length * 100
      const interval = Math.max(minIntervalMs, segmentMs - leadMs)
      const timer = setTimeout(() => sendSegment(next), interval)
      run.timers.add(timer)
    }

    sendSegment(0)
  }

  private cancelChannel(channel: Channel): void {
    const run = this.runs.get(channel)
    if (run === undefined) return
    for (const timer of run.timers) clearTimeout(timer)
    this.runs.delete(channel)
  }

  private resolved(): Required<SchedulerOptions> {
    return { ...DEFAULTS, ...this.options }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
