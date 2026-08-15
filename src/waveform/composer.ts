/**
 * Parametric waveform synthesizer: turns a small declarative spec into a flat
 * window list that the wave codec converts to protocol entries.
 *
 * Deterministic by default: the `random` curve uses a seeded LCG so the same
 * spec always produces the same waveform (reproducible for tests and for the
 * agent that wants to "play the same one as last time").
 */

import { CoyoteError } from '../errors.ts'
import { FREQ_MAX_MS, FREQ_MIN_MS, INTENSITY_MAX, INTENSITY_MIN, type WaveWindow } from '../protocol/wave.ts'

/** Interpolation shapes supported by both the frequency and intensity axes. */
export type Curve = 'linear' | 'sine' | 'pulse' | 'random'

/** One axis sweep from `from` to `to` over the spec duration. */
export interface AxisSpec {
  /** Start value (inclusive). */
  from: number
  /** End value (inclusive at t=1 for linear/sine; plateau for pulse). */
  to: number
  /** Interpolation shape. */
  curve: Curve
}

/** Rhythmic gating in addition to the two axes; omit for continuous output. */
export interface DutyCycleSpec {
  /** Seconds of active output per cycle. */
  onSec: number
  /** Seconds of silence (intensity 0) per cycle. */
  offSec: number
}

/** Complete declarative waveform description. */
export interface ComposeSpec {
  /** Frequency axis in milliseconds (10..1000). */
  freq: AxisSpec
  /** Intensity axis (0..100). */
  intensity: AxisSpec
  /** Total duration in seconds; must be positive. */
  durationSec: number
  /** Optional on/off rhythm. */
  dutyCycle?: DutyCycleSpec
}

/** Result of a synthesis run. */
export interface ComposedWave {
  /** Flat window list (4 windows per 100 ms entry). */
  windows: WaveWindow[]
  /** Entry count when encoded (durationSec * 10). */
  entryCount: number
}

const MAX_DURATION_SEC = 600

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function assertAxis(axis: AxisSpec, min: number, max: number, what: string): void {
  for (const [label, value] of [['from', axis.from], ['to', axis.to]] as const) {
    if (!Number.isFinite(value)) throw new CoyoteError(`${what}.${label} must be finite`)
    if (value < min || value > max) {
      throw new CoyoteError(`${what}.${label} must be within ${min}..${max}`)
    }
  }
}

/** Deterministic small PRNG (mulberry32) so random curves are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sampleCurve(curve: Curve, from: number, to: number, t: number, random: () => number): number {
  switch (curve) {
    case 'linear':
      return from + (to - from) * t
    case 'sine':
      // Smooth ease that starts and ends flat at the anchor values.
      return from + (to - from) * (1 - Math.cos(Math.PI * t)) / 2
    case 'pulse':
      // Square wave alternating between the two anchors each half period.
      return t < 0.5 ? from : to
    case 'random':
      return from + (to - from) * random()
  }
}

/** Synthesize one waveform from its spec. */
export function composeWave(spec: ComposeSpec, seed = 42): ComposedWave {
  assertAxis(spec.freq, FREQ_MIN_MS, FREQ_MAX_MS, 'freq')
  assertAxis(spec.intensity, INTENSITY_MIN, INTENSITY_MAX, 'intensity')
  if (!Number.isFinite(spec.durationSec) || spec.durationSec <= 0) {
    throw new CoyoteError('durationSec must be a positive number')
  }
  if (spec.durationSec > MAX_DURATION_SEC) {
    throw new CoyoteError(`durationSec cannot exceed ${MAX_DURATION_SEC}`)
  }
  if (spec.dutyCycle !== undefined) {
    const { onSec, offSec } = spec.dutyCycle
    if (!Number.isFinite(onSec) || onSec <= 0 || !Number.isFinite(offSec) || offSec <= 0) {
      throw new CoyoteError('dutyCycle onSec and offSec must be positive numbers')
    }
  }
  const random = mulberry32(seed)
  const windowCount = Math.round(spec.durationSec * 1000 / 25)
  const windows: WaveWindow[] = []
  for (let i = 0; i < windowCount; i += 1) {
    const t = windowCount === 1 ? 0 : i / (windowCount - 1)
    let intensity = sampleCurve(spec.intensity.curve, spec.intensity.from, spec.intensity.to, t, random)
    if (spec.dutyCycle !== undefined) {
      const cycleSec = spec.dutyCycle.onSec + spec.dutyCycle.offSec
      const phase = (i * 25 / 1000) % cycleSec
      if (phase >= spec.dutyCycle.onSec) intensity = 0
    }
    const freq = sampleCurve(spec.freq.curve, spec.freq.from, spec.freq.to, t, random)
    windows.push({
      freqMs: clamp(freq, FREQ_MIN_MS, FREQ_MAX_MS),
      intensity: Math.round(clamp(intensity, INTENSITY_MIN, INTENSITY_MAX)),
    })
  }
  return { windows, entryCount: Math.ceil(windowCount / 4) }
}
