/**
 * Built-in waveform library: twelve named presets built with the composer so
 * the shipped vocabulary needs no external data files.
 *
 * Every preset declares a suggested starting intensity so agents and new
 * users ramp up from a sane value instead of guessing.
 */

import type { ComposeSpec } from './composer.ts'
import { composeWave } from './composer.ts'
import type { WaveWindow } from '../protocol/wave.ts'

/** One built-in waveform definition. */
export interface BuiltInWaveform {
  /** Stable id used by tools and the GUI. */
  id: string
  /** English display name. */
  name: string
  /** Chinese display name. */
  nameZh: string
  /** One-line description for the model and the GUI tooltip. */
  description: string
  /** Suggested starting intensity in percent (0..100). */
  suggestedIntensityPercent: number
  /** Declarative spec; windows are synthesized lazily and cached. */
  readonly spec: ComposeSpec
}

interface BuiltInRuntime extends BuiltInWaveform {
  cached?: WaveWindow[]
}

const PRESETS: readonly BuiltInRuntime[] = [
  {
    id: 'breath',
    name: 'Breathing',
    nameZh: '呼吸',
    description: 'Slow sine swell, 6s in and out. Gentle continuous baseline.',
    suggestedIntensityPercent: 20,
    spec: {
      freq: { from: 300, to: 150, curve: 'sine' },
      intensity: { from: 10, to: 60, curve: 'sine' },
      durationSec: 6,
    },
  },
  {
    id: 'tide',
    name: 'Tide',
    nameZh: '浪潮',
    description: 'Rising swell that crashes down and repeats every 8 seconds.',
    suggestedIntensityPercent: 25,
    spec: {
      freq: { from: 400, to: 100, curve: 'sine' },
      intensity: { from: 5, to: 90, curve: 'sine' },
      durationSec: 8,
    },
  },
  {
    id: 'heartbeat',
    name: 'Heartbeat',
    nameZh: '心跳',
    description: 'Two quick thumps then rest, like a pulse at 60 bpm.',
    suggestedIntensityPercent: 25,
    spec: {
      freq: { from: 250, to: 250, curve: 'linear' },
      intensity: { from: 0, to: 80, curve: 'pulse' },
      durationSec: 2,
      dutyCycle: { onSec: 0.3, offSec: 0.7 },
    },
  },
  {
    id: 'tremor',
    name: 'Tremor',
    nameZh: '震颤',
    description: 'Fast constant buzz for a steady vibrating feel.',
    suggestedIntensityPercent: 20,
    spec: {
      freq: { from: 15, to: 15, curve: 'linear' },
      intensity: { from: 40, to: 40, curve: 'linear' },
      durationSec: 5,
    },
  },
  {
    id: 'tap',
    name: 'Tap',
    nameZh: '敲击',
    description: 'Discrete taps at 2 Hz with long gaps between them.',
    suggestedIntensityPercent: 30,
    spec: {
      freq: { from: 150, to: 150, curve: 'linear' },
      intensity: { from: 0, to: 90, curve: 'pulse' },
      durationSec: 4,
      dutyCycle: { onSec: 0.15, offSec: 0.35 },
    },
  },
  {
    id: 'knead',
    name: 'Knead',
    nameZh: '揉捏',
    description: 'Medium-frequency squeeze that slowly tightens and releases.',
    suggestedIntensityPercent: 25,
    spec: {
      freq: { from: 120, to: 60, curve: 'sine' },
      intensity: { from: 30, to: 80, curve: 'sine' },
      durationSec: 6,
    },
  },
  {
    id: 'punish',
    name: 'Punish',
    nameZh: '惩罚',
    description: 'Sharp high-frequency sting with a rising ramp. Intense.',
    suggestedIntensityPercent: 40,
    spec: {
      freq: { from: 30, to: 12, curve: 'linear' },
      intensity: { from: 50, to: 100, curve: 'linear' },
      durationSec: 10,
    },
  },
  {
    id: 'saw',
    name: 'Chainsaw',
    nameZh: '电锯',
    description: 'Aggressive revving bursts, like a power tool spooling up.',
    suggestedIntensityPercent: 35,
    spec: {
      freq: { from: 60, to: 10, curve: 'pulse' },
      intensity: { from: 30, to: 100, curve: 'linear' },
      durationSec: 6,
      dutyCycle: { onSec: 0.4, offSec: 0.2 },
    },
  },
  {
    id: 'scan',
    name: 'Wave Scan',
    nameZh: '波扫',
    description: 'Frequency sweeps smoothly from slow to fast and back.',
    suggestedIntensityPercent: 25,
    spec: {
      freq: { from: 900, to: 20, curve: 'sine' },
      intensity: { from: 50, to: 50, curve: 'linear' },
      durationSec: 10,
    },
  },
  {
    id: 'random-soft',
    name: 'Random Caress',
    nameZh: '随机轻抚',
    description: 'Unpredictable gentle fluctuations; never the same twice a second.',
    suggestedIntensityPercent: 20,
    spec: {
      freq: { from: 200, to: 60, curve: 'random' },
      intensity: { from: 15, to: 55, curve: 'random' },
      durationSec: 8,
    },
  },
  {
    id: 'pulse-train',
    name: 'Pulse Train',
    nameZh: '脉冲列',
    description: 'Metronome-like regular pulses at 1 Hz, machine precision.',
    suggestedIntensityPercent: 30,
    spec: {
      freq: { from: 100, to: 100, curve: 'linear' },
      intensity: { from: 10, to: 85, curve: 'linear' },
      durationSec: 5,
      dutyCycle: { onSec: 0.1, offSec: 0.9 },
    },
  },
  {
    id: 'calm',
    name: 'Calm Down',
    nameZh: '安抚',
    description: 'Decaying fade-out that settles everything back to quiet.',
    suggestedIntensityPercent: 15,
    spec: {
      freq: { from: 200, to: 500, curve: 'sine' },
      intensity: { from: 60, to: 0, curve: 'linear' },
      durationSec: 8,
    },
  },
]

/** All built-in waveform definitions (specs only, cheap to copy). */
export const BUILT_IN_WAVEFORMS: readonly BuiltInWaveform[] = PRESETS

/** Look up one built-in by id (case-insensitive). */
export function getBuiltIn(id: string): BuiltInWaveform | undefined {
  const wanted = id.trim().toLowerCase()
  return PRESETS.find(wave => wave.id === wanted)
}

/** Synthesize (and cache) the windows of one built-in preset. */
export function builtInWindows(id: string): WaveWindow[] {
  const wave = getBuiltIn(id)
  if (wave === undefined) return []
  const runtime = wave as BuiltInRuntime
  runtime.cached ??= composeWave(wave.spec).windows
  return runtime.cached
}
