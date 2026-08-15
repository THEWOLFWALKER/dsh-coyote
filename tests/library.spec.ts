import { describe, expect, it } from 'vitest'
import { BUILT_IN_WAVEFORMS, builtInWindows, getBuiltIn } from '../src/waveform/library.ts'

describe('built-in library', () => {
  it('ships twelve presets with unique ids and sane suggestions', () => {
    expect(BUILT_IN_WAVEFORMS).toHaveLength(12)
    const ids = new Set(BUILT_IN_WAVEFORMS.map(wave => wave.id))
    expect(ids.size).toBe(BUILT_IN_WAVEFORMS.length)
    for (const wave of BUILT_IN_WAVEFORMS) {
      expect(wave.name.length).toBeGreaterThan(0)
      expect(wave.nameZh.length).toBeGreaterThan(0)
      expect(wave.suggestedIntensityPercent).toBeGreaterThan(0)
      expect(wave.suggestedIntensityPercent).toBeLessThanOrEqual(50)
    }
  })

  it('synthesizes encodable windows for every preset', () => {
    for (const wave of BUILT_IN_WAVEFORMS) {
      const windows = builtInWindows(wave.id)
      expect(windows.length % 4).toBe(0)
      expect(windows.length).toBe(Math.round(wave.spec.durationSec * 1000 / 25))
    }
  })

  it('looks up presets case-insensitively and caches synthesis', () => {
    expect(getBuiltIn('Breath')?.id).toBe('breath')
    expect(getBuiltIn('nope')).toBeUndefined()
    expect(builtInWindows('nope')).toEqual([])
    expect(builtInWindows('tide')).toBe(builtInWindows('tide'))
  })
})
