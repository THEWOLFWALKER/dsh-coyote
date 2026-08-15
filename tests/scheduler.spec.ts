import { describe, expect, it, vi, afterEach } from 'vitest'
import { WaveScheduler, mirrorEntry, type PlayRequest, type WaveTransport } from '../src/waveform/scheduler.ts'

class FakeTransport implements WaveTransport {
  readonly sent: Array<{ channel: string; entries: string[] }> = []
  readonly cleared: string[] = []
  failSends = false

  async sendPulse(channel: 'A' | 'B', entries: readonly string[]): Promise<void> {
    if (this.failSends) throw new Error('send failed')
    this.sent.push({ channel, entries: [...entries] })
  }

  async clearPulse(channel: 'A' | 'B'): Promise<void> {
    this.cleared.push(channel)
  }
}

const entry = (value: number): string => value.toString(16).padStart(2, '0').repeat(8)
const entries = (count: number): string[] => Array.from({ length: count }, (_, i) => entry(i % 100))

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Start a play under fake timers: `play()` awaits the internal clear gap,
 * so the gap must elapse before the returned promise can settle.
 */
async function play(scheduler: WaveScheduler, request: PlayRequest, gapMs = 150): Promise<unknown> {
  const promise = scheduler.play(request)
  await vi.advanceTimersByTimeAsync(gapMs + 1)
  return promise
}

describe('mirrorEntry', () => {
  it('inverts the intensity axis and keeps frequency bytes', () => {
    // freq 0a0a0a0a + intensity 00 0a 14 1e -> 64 5a 50 46 (100-v per byte).
    expect(mirrorEntry('0a0a0a0a000a141e')).toBe('0a0a0a0a645a5046')
    expect(mirrorEntry('0a0a0a0a645a5046')).toBe('0a0a0a0a000a141e')
  })
})

describe('WaveScheduler', () => {
  it('segments long lists and feeds the next segment before starvation', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const scheduler = new WaveScheduler(transport, { segmentSize: 10, leadMs: 200 })
    await play(scheduler, {
      entries: entries(25),
      channel: 'A',
      mode: 'once',
      durationSec: 10,
    })
    // First segment went out immediately after the clear gap (t=151ms).
    expect(transport.sent[0]!.entries).toHaveLength(10)
    // The follow-up timer starts when the first send runs (~t=151), so it
    // fires at 151 + (1000 - 200) = 951ms on the fake clock.
    await vi.advanceTimersByTimeAsync(700)
    expect(transport.sent.filter(s => s.channel === 'A')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(transport.sent.filter(s => s.channel === 'A')).toHaveLength(2)
    // Third send lands 800ms after the second (t~1750).
    await vi.advanceTimersByTimeAsync(799)
    expect(transport.sent.filter(s => s.channel === 'A')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2)
    expect(transport.sent.filter(s => s.channel === 'A')).toHaveLength(3)
    expect(transport.sent.at(-1)!.entries).toHaveLength(5)
  })

  it('clears the target channel before starting and honors mirrorB', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const scheduler = new WaveScheduler(transport, { segmentSize: 10, clearGapMs: 10 })
    await play(scheduler, {
      entries: [entry(50)],
      channel: 'both',
      mode: 'once',
      durationSec: 5,
      mirrorB: true,
    }, 10)
    expect(transport.cleared).toEqual(['A', 'B'])
    const a = transport.sent.find(s => s.channel === 'A')
    const b = transport.sent.find(s => s.channel === 'B')
    expect(a!.entries[0]).toBe(entry(50))
    expect(b!.entries[0]).toBe(mirrorEntry(entry(50)))
  })

  it('loops until the duration cap and then stops cleanly', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const scheduler = new WaveScheduler(transport, { segmentSize: 10, leadMs: 100 })
    await play(scheduler, {
      entries: entries(10),
      channel: 'A',
      mode: 'loop',
      durationSec: 5,
    })
    expect(scheduler.isPlaying()).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scheduler.isPlaying()).toBe(false)
    // One send per ~900ms over a 5s window: between 4 and 7 sends.
    const count = transport.sent.length
    expect(count).toBeGreaterThanOrEqual(4)
    expect(count).toBeLessThanOrEqual(7)
  })

  it('clears the device queue when the duration cap ends the run', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const scheduler = new WaveScheduler(transport, { segmentSize: 10, leadMs: 100 })
    await play(scheduler, { entries: entries(10), channel: 'A', mode: 'loop', durationSec: 5 })
    // One pre-play clear, then the cap must drop whatever is still queued.
    const clearsAtStart = transport.cleared.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scheduler.isPlaying()).toBe(false)
    expect(transport.cleared.filter(channel => channel === 'A').length).toBeGreaterThanOrEqual(clearsAtStart + 1)
  })

  it('clears the device queue after a once-mode pass ends', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const scheduler = new WaveScheduler(transport, { segmentSize: 10, leadMs: 100 })
    await play(scheduler, { entries: entries(10), channel: 'A', mode: 'once', durationSec: 1 })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(scheduler.isPlaying()).toBe(false)
    // Pre-play clear + end-of-run clear, both on channel A.
    expect(transport.cleared.filter(channel => channel === 'A').length).toBe(2)
  })

  it('replaces a running playback without stale timers firing', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const scheduler = new WaveScheduler(transport, { segmentSize: 10, leadMs: 100 })
    await play(scheduler, { entries: entries(30), channel: 'A', mode: 'loop', durationSec: 60 })
    const firstCount = transport.sent.length
    await play(scheduler, { entries: entries(5), channel: 'A', mode: 'once', durationSec: 1 })
    await vi.advanceTimersByTimeAsync(120_000)
    // Only the second, shorter play kept sending after its own end.
    const later = transport.sent.slice(firstCount)
    expect(later.every(s => s.entries.length === 5)).toBe(true)
  })

  it('stopAll cancels timers and clears both channels', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const scheduler = new WaveScheduler(transport, { segmentSize: 10 })
    await play(scheduler, { entries: entries(30), channel: 'both', mode: 'loop', durationSec: 60 })
    expect(scheduler.isPlaying()).toBe(true)
    await scheduler.stopAll()
    expect(scheduler.isPlaying()).toBe(false)
    const clears = transport.cleared.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(transport.cleared.length).toBe(clears)
  })

  it('contains send failures instead of killing the process', async () => {
    vi.useFakeTimers()
    const failures: unknown[] = []
    const transport = new FakeTransport()
    transport.failSends = true
    const scheduler = new WaveScheduler(transport, { segmentSize: 10 }, error => failures.push(error))
    await play(scheduler, { entries: entries(10), channel: 'A', mode: 'once', durationSec: 2 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(failures.length).toBeGreaterThan(0)
    expect(scheduler.isPlaying()).toBe(false)
  })

  it('validates requests', async () => {
    const scheduler = new WaveScheduler(new FakeTransport())
    await expect(scheduler.play({ entries: [], channel: 'A', mode: 'once', durationSec: 1 })).rejects.toThrow(/at least one/)
    await expect(scheduler.play({ entries: entries(1), channel: 'A', mode: 'once', durationSec: 0 })).rejects.toThrow(/positive/)
  })
})
