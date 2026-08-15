import { describe, expect, it } from 'vitest'
import { CoyoteError } from '../src/errors.ts'
import {
  compressFrequency,
  decodeWaveEntry,
  decodeWaveSequence,
  encodeWaveEntry,
  encodeWaveSequence,
  expandFrequency,
  isWaveEntryHex,
} from '../src/protocol/wave.ts'

describe('wave codec', () => {
  it('matches the official conversion table for linear periods', () => {
    // coyote/extra/README.md example 2: linear waveform-frequency values.
    const periods = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    const codes = periods.map(compressFrequency)
    expect(codes).toEqual([100, 120, 140, 160, 180, 200, 210, 220, 230, 240])
  })

  it('matches the official table for linear pulse frequencies', () => {
    // coyote/extra/README.md example 1: 1..10 Hz mapped through the formula.
    const hz = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const codes = hz.map(frequency => compressFrequency(1000 / frequency))
    expect(codes).toEqual([240, 180, 146, 130, 120, 113, 108, 105, 102, 100])
  })

  it('clamps out-of-domain periods instead of throwing', () => {
    expect(compressFrequency(1)).toBe(10)
    expect(compressFrequency(5000)).toBe(240)
    expect(() => compressFrequency(Number.NaN)).toThrow(/finite/)
  })

  it('expands codes back into period bounds', () => {
    expect(expandFrequency(10)).toBe(10)
    expect(expandFrequency(100)).toBe(100)
    expect(expandFrequency(120)).toBe(200)
    expect(expandFrequency(240)).toBe(1000)
    expect(() => expandFrequency(9)).toThrow(/10 to 240/)
    expect(() => expandFrequency(241)).toThrow(/10 to 240/)
  })

  it('round-trips the official V3 example window as an 8-byte entry', () => {
    // B0 example No.1 window 1: freq {10,10,10,10} intensity {0,10,20,30}.
    const windows = [
      { freqMs: 10, intensity: 0 },
      { freqMs: 10, intensity: 10 },
      { freqMs: 10, intensity: 20 },
      { freqMs: 10, intensity: 30 },
    ]
    expect(encodeWaveEntry(windows)).toBe('0a0a0a0a000a141e')
    expect(decodeWaveEntry('0a0a0a0a000a141e')).toEqual([
      { freqMs: 10, intensity: 0 },
      { freqMs: 10, intensity: 10 },
      { freqMs: 10, intensity: 20 },
      { freqMs: 10, intensity: 30 },
    ])
  })

  it('rejects malformed entries and invalid domain bytes', () => {
    expect(() => decodeWaveEntry('0a0a0a0a000a141')).toThrow(/16 hex/)
    expect(() => decodeWaveEntry('0a0a0a0a000a14zz')).toThrow(/16 hex/)
    // Intensity byte 0x65 = 101 is the documented invalid value that voids a channel.
    expect(() => decodeWaveEntry('0a0a0a0a0a650a0a')).toThrow(/intensity/)
    // Frequency byte below 10 is outside the compressed domain.
    expect(() => decodeWaveEntry('090a0a0a000a141e')).toThrow(/frequency/)
    expect(isWaveEntryHex('0a0a0a0a000a141e')).toBe(true)
    expect(isWaveEntryHex('nope')).toBe(false)
  })

  it('validates windows before encoding', () => {
    const base = { freqMs: 50, intensity: 50 }
    expect(() => encodeWaveEntry([base, base, base])).toThrow(/exactly 4/)
    expect(() => encodeWaveEntry([
      { freqMs: 5, intensity: 50 },
      base,
      base,
      base,
    ])).toThrow(/window 0/)
    expect(() => encodeWaveEntry([
      base,
      base,
      base,
      { freqMs: 50, intensity: 101 },
    ])).toThrow(/window 3/)
  })

  it('encodes and decodes multi-entry sequences', () => {
    const windows = [
      { freqMs: 100, intensity: 10 },
      { freqMs: 100, intensity: 20 },
      { freqMs: 100, intensity: 30 },
      { freqMs: 100, intensity: 40 },
      { freqMs: 700, intensity: 60 },
      { freqMs: 700, intensity: 60 },
      { freqMs: 700, intensity: 60 },
      { freqMs: 700, intensity: 60 },
    ]
    const entries = encodeWaveSequence(windows)
    expect(entries).toHaveLength(2)
    expect(decodeWaveSequence(entries)).toEqual(windows)
    expect(() => encodeWaveSequence(windows.slice(0, 5))).toThrow(/multiple of 4/)
    expect(() => encodeWaveSequence([])).toThrow(/at least one/)
  })
})
