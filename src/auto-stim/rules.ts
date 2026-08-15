/**
 * Auto-stim vocabulary: the eleven domain events, per-event rules, defaults,
 * normalization, and the Schemastery schema for deployment config.
 *
 * Design: the mapper (mapper.ts) reduces DSH host events to this small closed
 * vocabulary; the engine (engine.ts) only knows these names. The default
 * table below is the single source of truth for docs, schema defaults, and
 * tests — every intensity stays at or under the default `maxIntensity` so a
 * freshly enabled autoStim never exceeds tickle level out of the box.
 */

import z from '@deepseek-ai/schemastery'
import { CoyoteError } from '../errors.ts'
import type { ChannelSelection } from '../types.ts'

/** Every domain event auto-stim can react to. */
export const AUTO_STIM_EVENTS = [
  'turn_start',
  'assistant_start',
  'stream_tick',
  'tool_call',
  'tool_error',
  'agent_error',
  'turn_end_completed',
  'turn_end_aborted',
  'turn_end_max_tokens',
  'todo_clear',
  'agent_idle',
] as const

export type AutoStimEvent = (typeof AUTO_STIM_EVENTS)[number]

/** One event → stimulus rule. */
export interface AutoStimRule {
  /** Whether this event triggers at all. */
  enabled: boolean
  /** Built-in waveform id or imported waveform name (resolved at fire time). */
  waveform: string
  /** Channel-strength target in the 0..200 domain; further clamped by `maxIntensity` and the runtime envelope. */
  intensity: number
  /** Waveform playback length in seconds. */
  durationSec: number
  /** Channels the pulse drives. */
  channel: ChannelSelection
}

/** Global settings shared by every rule. */
export interface AutoStimSettings {
  /** Extra hard cap applied on top of every rule intensity (1..200). */
  maxIntensity: number
  /** Minimum seconds between two auto triggers (spam guard). */
  cooldownSec: number
  /** Minimum seconds between two stream ticks while output streams. */
  tickIntervalSec: number
  /** Restore the pre-pulse channel strength after each pulse. */
  restoreBaseline: boolean
}

/** Fully normalized auto-stim configuration (every field resolved and valid). */
export interface AutoStimConfig extends AutoStimSettings {
  rules: Record<AutoStimEvent, AutoStimRule>
}

/** User-facing shape before normalization: everything optional, `events` loose. */
export interface AutoStimUserConfig {
  enabled?: boolean
  maxIntensity?: number
  cooldownSec?: number
  tickIntervalSec?: number
  restoreBaseline?: boolean
  events?: unknown
}

/** Defaults for the global settings. */
export const DEFAULT_AUTO_STIM_SETTINGS: AutoStimSettings = {
  maxIntensity: 30,
  cooldownSec: 5,
  tickIntervalSec: 5,
  restoreBaseline: true,
}

/** The default rule table: tickle-level intensities, gentle waves, mostly on. */
export const DEFAULT_AUTO_STIM_RULES: Record<AutoStimEvent, AutoStimRule> = {
  turn_start: { enabled: true, waveform: 'tap', intensity: 12, durationSec: 2, channel: 'A' },
  assistant_start: { enabled: true, waveform: 'tap', intensity: 15, durationSec: 2, channel: 'A' },
  stream_tick: { enabled: false, waveform: 'tremor', intensity: 15, durationSec: 2, channel: 'A' },
  tool_call: { enabled: true, waveform: 'tap', intensity: 20, durationSec: 2, channel: 'A' },
  tool_error: { enabled: true, waveform: 'punish', intensity: 25, durationSec: 6, channel: 'A' },
  agent_error: { enabled: true, waveform: 'punish', intensity: 30, durationSec: 8, channel: 'A' },
  turn_end_completed: { enabled: true, waveform: 'heartbeat', intensity: 20, durationSec: 4, channel: 'A' },
  turn_end_aborted: { enabled: false, waveform: 'calm', intensity: 12, durationSec: 3, channel: 'A' },
  turn_end_max_tokens: { enabled: false, waveform: 'saw', intensity: 20, durationSec: 3, channel: 'A' },
  todo_clear: { enabled: true, waveform: 'heartbeat', intensity: 18, durationSec: 4, channel: 'A' },
  agent_idle: { enabled: false, waveform: 'calm', intensity: 12, durationSec: 4, channel: 'A' },
}

const CHANNELS: readonly ChannelSelection[] = ['A', 'B', 'both']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function intInRange(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new CoyoteError(`dsh-coyote autoStim: ${what} must be an integer from ${min} to ${max}`)
  }
  return value
}

function positiveNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CoyoteError(`dsh-coyote autoStim: ${what} must be a positive number`)
  }
  return value
}

function nonNegativeNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CoyoteError(`dsh-coyote autoStim: ${what} must be a number >= 0`)
  }
  return value
}

function booleanValue(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new CoyoteError(`dsh-coyote autoStim: ${what} must be a boolean`)
  }
  return value
}

function normalizeRule(event: AutoStimEvent, raw: unknown): AutoStimRule {
  const fallback = DEFAULT_AUTO_STIM_RULES[event]
  if (raw === undefined) return { ...fallback }
  if (!isRecord(raw)) {
    throw new CoyoteError(`dsh-coyote autoStim: events.${event} must be an object`)
  }
  const enabled = 'enabled' in raw ? booleanValue(raw.enabled, `events.${event}.enabled`) : fallback.enabled
  const waveform = 'waveform' in raw && raw.waveform !== undefined
    ? (() => {
        if (typeof raw.waveform !== 'string' || raw.waveform.trim() === '') {
          throw new CoyoteError(`dsh-coyote autoStim: events.${event}.waveform must be a non-empty string`)
        }
        return raw.waveform.trim()
      })()
    : fallback.waveform
  const intensity = 'intensity' in raw && raw.intensity !== undefined
    ? intInRange(raw.intensity, `events.${event}.intensity`, 1, 200)
    : fallback.intensity
  const durationSec = 'durationSec' in raw && raw.durationSec !== undefined
    ? positiveNumber(raw.durationSec, `events.${event}.durationSec`)
    : fallback.durationSec
  const channel = 'channel' in raw && raw.channel !== undefined
    ? (() => {
        if (typeof raw.channel !== 'string' || !CHANNELS.includes(raw.channel as ChannelSelection)) {
          throw new CoyoteError(`dsh-coyote autoStim: events.${event}.channel must be one of A, B, both`)
        }
        return raw.channel as ChannelSelection
      })()
    : fallback.channel
  return { enabled, waveform, intensity, durationSec, channel }
}

/**
 * Fill defaults, merge per-field overrides, and validate everything.
 * Unknown event names are rejected with the full valid list — a typo like
 * `tool_eror` must fail loudly at startup, not silently never fire.
 */
export function normalizeAutoStimConfig(raw: unknown): AutoStimConfig {
  const input = raw === undefined || raw === null ? {} : raw
  if (!isRecord(input)) {
    throw new CoyoteError('dsh-coyote autoStim: must be an object')
  }

  const settings: AutoStimSettings = {
    maxIntensity: 'maxIntensity' in input && input.maxIntensity !== undefined
      ? intInRange(input.maxIntensity, 'maxIntensity', 1, 200)
      : DEFAULT_AUTO_STIM_SETTINGS.maxIntensity,
    cooldownSec: 'cooldownSec' in input && input.cooldownSec !== undefined
      ? nonNegativeNumber(input.cooldownSec, 'cooldownSec')
      : DEFAULT_AUTO_STIM_SETTINGS.cooldownSec,
    tickIntervalSec: 'tickIntervalSec' in input && input.tickIntervalSec !== undefined
      ? Math.max(1, positiveNumber(input.tickIntervalSec, 'tickIntervalSec'))
      : DEFAULT_AUTO_STIM_SETTINGS.tickIntervalSec,
    restoreBaseline: 'restoreBaseline' in input && input.restoreBaseline !== undefined
      ? booleanValue(input.restoreBaseline, 'restoreBaseline')
      : DEFAULT_AUTO_STIM_SETTINGS.restoreBaseline,
  }

  const events = input.events === undefined || input.events === null ? {} : input.events
  if (!isRecord(events)) {
    throw new CoyoteError('dsh-coyote autoStim: events must be an object')
  }
  for (const key of Object.keys(events)) {
    if (!(AUTO_STIM_EVENTS as readonly string[]).includes(key)) {
      throw new CoyoteError(
        `dsh-coyote autoStim: unknown event "${key}"; valid events are ${AUTO_STIM_EVENTS.join(', ')}`,
      )
    }
  }

  const rules = {} as Record<AutoStimEvent, AutoStimRule>
  for (const event of AUTO_STIM_EVENTS) {
    rules[event] = normalizeRule(event, events[event])
  }

  return { ...settings, rules }
}

/**
 * Schemastery schema for the deployment config. Leaf defaults mirror the
 * tables above for host-UI display; `events` stays loose (`z.any()`) because
 * normalizeAutoStimConfig is the single validation authority — a strict
 * nested schema could silently drop unknown keys (typos) before normalize
 * ever sees them.
 */
export function autoStimSchema() {
  return z.object({
    enabled: z.boolean().default(false),
    maxIntensity: z.number().default(DEFAULT_AUTO_STIM_SETTINGS.maxIntensity),
    cooldownSec: z.number().default(DEFAULT_AUTO_STIM_SETTINGS.cooldownSec),
    tickIntervalSec: z.number().default(DEFAULT_AUTO_STIM_SETTINGS.tickIntervalSec),
    restoreBaseline: z.boolean().default(DEFAULT_AUTO_STIM_SETTINGS.restoreBaseline),
    events: z.any(),
  })
}
