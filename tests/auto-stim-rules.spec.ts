import { describe, expect, it } from 'vitest'
import { CoyoteError } from '../src/errors.ts'
import {
  AUTO_STIM_EVENTS,
  DEFAULT_AUTO_STIM_RULES,
  DEFAULT_AUTO_STIM_SETTINGS,
  normalizeAutoStimConfig,
} from '../src/auto-stim/rules.ts'

describe('auto-stim rules', () => {
  it('fills every field from the default tables', () => {
    const config = normalizeAutoStimConfig(undefined)
    expect(config.maxIntensity).toBe(DEFAULT_AUTO_STIM_SETTINGS.maxIntensity)
    expect(config.cooldownSec).toBe(DEFAULT_AUTO_STIM_SETTINGS.cooldownSec)
    expect(config.tickIntervalSec).toBe(DEFAULT_AUTO_STIM_SETTINGS.tickIntervalSec)
    expect(config.restoreBaseline).toBe(DEFAULT_AUTO_STIM_SETTINGS.restoreBaseline)
    expect(Object.keys(config.rules)).toHaveLength(AUTO_STIM_EVENTS.length)
    expect(config.rules).toEqual(DEFAULT_AUTO_STIM_RULES)
  })

  it('keeps every default rule at or under the default maxIntensity', () => {
    for (const rule of Object.values(DEFAULT_AUTO_STIM_RULES)) {
      expect(rule.intensity).toBeLessThanOrEqual(DEFAULT_AUTO_STIM_SETTINGS.maxIntensity)
      expect(rule.intensity).toBeGreaterThan(0)
      expect(rule.durationSec).toBeGreaterThan(0)
    }
  })

  it('accepts null like undefined', () => {
    expect(normalizeAutoStimConfig(null)).toEqual(normalizeAutoStimConfig(undefined))
  })

  it('overrides global settings', () => {
    const config = normalizeAutoStimConfig({
      maxIntensity: 60,
      cooldownSec: 0,
      tickIntervalSec: 2.5,
      restoreBaseline: false,
    })
    expect(config.maxIntensity).toBe(60)
    expect(config.cooldownSec).toBe(0)
    expect(config.tickIntervalSec).toBe(2.5)
    expect(config.restoreBaseline).toBe(false)
  })

  it('merges per-event overrides field by field', () => {
    const config = normalizeAutoStimConfig({ events: { tool_error: { intensity: 40, channel: 'both' } } })
    const rule = config.rules.tool_error
    const fallback = DEFAULT_AUTO_STIM_RULES.tool_error
    expect(rule.enabled).toBe(fallback.enabled)
    expect(rule.waveform).toBe(fallback.waveform)
    expect(rule.durationSec).toBe(fallback.durationSec)
    expect(rule.intensity).toBe(40)
    expect(rule.channel).toBe('both')
  })

  it('rejects unknown event names with the valid list', () => {
    expect(() => normalizeAutoStimConfig({ events: { tool_eror: {} } })).toThrow(CoyoteError)
    expect(() => normalizeAutoStimConfig({ events: { tool_eror: {} } })).toThrow(/tool_eror/)
    expect(() => normalizeAutoStimConfig({ events: { tool_eror: {} } })).toThrow(new RegExp(AUTO_STIM_EVENTS[0]!))
  })

  it('rejects malformed values loudly', () => {
    expect(() => normalizeAutoStimConfig({ maxIntensity: 0 })).toThrow(/maxIntensity/)
    expect(() => normalizeAutoStimConfig({ maxIntensity: 201 })).toThrow(/maxIntensity/)
    expect(() => normalizeAutoStimConfig({ maxIntensity: 1.5 })).toThrow(/maxIntensity/)
    expect(() => normalizeAutoStimConfig({ cooldownSec: -1 })).toThrow(/cooldownSec/)
    expect(() => normalizeAutoStimConfig({ tickIntervalSec: 0 })).toThrow(/tickIntervalSec/)
    expect(() => normalizeAutoStimConfig({ restoreBaseline: 'yes' })).toThrow(/restoreBaseline/)
    expect(() => normalizeAutoStimConfig({ events: { turn_start: { intensity: 300 } } })).toThrow(/intensity/)
    expect(() => normalizeAutoStimConfig({ events: { turn_start: { durationSec: 0 } } })).toThrow(/durationSec/)
    expect(() => normalizeAutoStimConfig({ events: { turn_start: { channel: 'C' } } })).toThrow(/channel/)
    expect(() => normalizeAutoStimConfig({ events: { turn_start: { enabled: 1 } } })).toThrow(/enabled/)
    expect(() => normalizeAutoStimConfig({ events: { turn_start: 'zap' } })).toThrow(/events\.turn_start/)
    expect(() => normalizeAutoStimConfig({ events: 'zap' })).toThrow(/events/)
    expect(() => normalizeAutoStimConfig(42)).toThrow(/autoStim/)
  })

  it('accepts arbitrary waveform strings (resolved at fire time)', () => {
    const config = normalizeAutoStimConfig({ events: { turn_start: { waveform: 'My imported wave' } } })
    expect(config.rules.turn_start!.waveform).toBe('My imported wave')
    expect(() => normalizeAutoStimConfig({ events: { turn_start: { waveform: '   ' } } })).toThrow(/waveform/)
  })
})
