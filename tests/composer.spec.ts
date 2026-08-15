import { describe, expect, it } from 'vitest'
import { CoyoteError } from '../src/errors.ts'
import { composeWave } from '../src/waveform/composer.ts'
import { encodeWaveEntry } from '../src/protocol/wave.ts'

describe('composer', () => {
  it('produces exactly 40 windows per second', () => {
    const wave = composeWave({
      freq: { from: 100, to: 100, curve: 'linear' },
      intensity: { from: 10, to: 20, curve: 'linear' },
      durationSec: 3,
    })
    expect(wave.windows).toHaveLength(120)
    expect(wave.entryCount).toBe(30)
  })

  it('is deterministic including the random curve', () => {
    const spec = {
      freq: { from: 200, to: 60, curve: 'random' as const },
      intensity: { from: 15, to: 55, curve: 'random' as const },
      durationSec: 2,
    }
    expect(composeWave(spec, 7).windows).toEqual(composeWave(spec, 7).windows)
    expect(composeWave(spec, 7).windows).not.toEqual(composeWave(spec, 8).windows)
  })

  it('interpolates each curve shape as documented', () => {
    const base = { durationSec: 1 }
    const linear = composeWave({
      ...base,
      freq: { from: 100, to: 200, curve: 'linear' },
      intensity: { from: 0, to: 100, curve: 'linear' },
    })
    const first = linear.windows[0]!
    const last = linear.windows.at(-1)!
    expect(first.freqMs).toBe(100)
    expect(last.freqMs).toBe(200)
    expect(last.intensity).toBe(100)

    const sine = composeWave({
      ...base,
      freq: { from: 100, to: 100, curve: 'sine' },
      intensity: { from: 0, to: 100, curve: 'sine' },
    })
    const midIndex = Math.floor(sine.windows.length / 2)
    const midT = midIndex / (sine.windows.length - 1)
    expect(sine.windows[midIndex]!.intensity).toBe(Math.round(100 * (1 - Math.cos(Math.PI * midT)) / 2))

    const pulse = composeWave({
      ...base,
      freq: { from: 100, to: 100, curve: 'linear' },
      intensity: { from: 10, to: 90, curve: 'pulse' },
    })
    expect(pulse.windows[0]!.intensity).toBe(10)
    expect(pulse.windows.at(-1)!.intensity).toBe(90)
  })

  it('gates output with the duty cycle and forces silence in off phases', () => {
    const wave = composeWave({
      freq: { from: 100, to: 100, curve: 'linear' },
      intensity: { from: 50, to: 50, curve: 'linear' },
      durationSec: 2,
      dutyCycle: { onSec: 0.5, offSec: 0.5 },
    })
    // Window 30 is 0.75s into playback: inside the off phase.
    expect(wave.windows[30]!.intensity).toBe(0)
    expect(wave.windows[5]!.intensity).toBe(50)
  })

  it('keeps every window inside the protocol domain', () => {
    const wave = composeWave({
      freq: { from: 10, to: 1000, curve: 'random' },
      intensity: { from: 0, to: 100, curve: 'random' },
      durationSec: 5,
    })
    for (const window of wave.windows) {
      expect(window.freqMs).toBeGreaterThanOrEqual(10)
      expect(window.freqMs).toBeLessThanOrEqual(1000)
      expect(window.intensity).toBeGreaterThanOrEqual(0)
      expect(window.intensity).toBeLessThanOrEqual(100)
      expect(Number.isInteger(window.intensity)).toBe(true)
    }
    // The full list must encode without codec errors.
    for (let i = 0; i + 4 <= wave.windows.length; i += 4) {
      expect(() => encodeWaveEntry(wave.windows.slice(i, i + 4))).not.toThrow()
    }
  })

  it('rejects out-of-domain specs', () => {
    expect(() => composeWave({
      freq: { from: 5, to: 100, curve: 'linear' },
      intensity: { from: 0, to: 50, curve: 'linear' },
      durationSec: 1,
    })).toThrow(/freq\.from/)
    expect(() => composeWave({
      freq: { from: 100, to: 100, curve: 'linear' },
      intensity: { from: 0, to: 101, curve: 'linear' },
      durationSec: 1,
    })).toThrow(/intensity\.to/)
    expect(() => composeWave({
      freq: { from: 100, to: 100, curve: 'linear' },
      intensity: { from: 0, to: 50, curve: 'linear' },
      durationSec: 0,
    })).toThrow(/durationSec/)
    expect(() => composeWave({
      freq: { from: 100, to: 100, curve: 'linear' },
      intensity: { from: 0, to: 50, curve: 'linear' },
      durationSec: 5,
      dutyCycle: { onSec: 0, offSec: 1 },
    })).toThrow(/dutyCycle/)
  })
})
