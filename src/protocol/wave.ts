/**
 * Pure V3 waveform entry codec.
 *
 * One waveform entry is 8 bytes of hex (16 characters) covering 100 ms as
 * four 25 ms windows: [freq x4][intensity x4]. Frequency bytes carry the
 * compressed period domain 10..240; intensity bytes carry 0..100. Source:
 * DG-LAB-OPENSOURCE coyote/v3/README_V3.md and coyote/extra/README.md.
 */

import { CoyoteError } from '../errors.ts'

/** Minimum waveform period in the input domain (10 ms = 100 Hz). */
export const FREQ_MIN_MS = 10

/** Maximum waveform period in the input domain (1000 ms = 1 Hz). */
export const FREQ_MAX_MS = 1000

/** Minimum compressed frequency byte. */
export const FREQ_CODE_MIN = 10

/** Maximum compressed frequency byte. */
export const FREQ_CODE_MAX = 240

/** Minimum waveform intensity byte. */
export const INTENSITY_MIN = 0

/** Maximum waveform intensity byte. */
export const INTENSITY_MAX = 100

/** Windows per waveform entry (4 x 25 ms = 100 ms). */
export const WINDOWS_PER_ENTRY = 4

/** One 25 ms output window. */
export interface WaveWindow {
  /** Output-unit period in milliseconds within 10..1000. */
  freqMs: number
  /** Relative waveform intensity within 0..100. */
  intensity: number
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Compress a period in ms (10..1000) into the protocol byte domain (10..240).
 *
 * Official mapping: 10..100 kept, 101..600 -> (x-100)/5+100,
 * 601..1000 -> (x-600)/10+200, floored to integers (verified against the
 * official conversion table in coyote/extra/README.md).
 */
export function compressFrequency(periodMs: number): number {
  if (!Number.isFinite(periodMs)) throw new CoyoteError('frequency period must be a finite number')
  const period = clamp(periodMs, FREQ_MIN_MS, FREQ_MAX_MS)
  if (period <= 100) return Math.floor(period)
  if (period <= 600) return Math.floor((period - 100) / 5 + 100)
  return Math.floor((period - 600) / 10 + 200)
}

/**
 * Expand a compressed frequency byte (10..240) back to a period in ms.
 *
 * Exact inverse for exact compressed points; otherwise returns the lower
 * bound of the covered period range.
 */
export function expandFrequency(code: number): number {
  if (!Number.isInteger(code) || code < FREQ_CODE_MIN || code > FREQ_CODE_MAX) {
    throw new CoyoteError(`frequency code must be an integer from ${FREQ_CODE_MIN} to ${FREQ_CODE_MAX}`)
  }
  if (code <= 100) return code
  if (code <= 200) return (code - 100) * 5 + 100
  return (code - 200) * 10 + 600
}

function byteHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

function assertWindow(window: WaveWindow, index: number): void {
  if (!Number.isFinite(window.freqMs)) {
    throw new CoyoteError(`window ${index}: frequency must be finite`)
  }
  if (window.freqMs < FREQ_MIN_MS || window.freqMs > FREQ_MAX_MS) {
    throw new CoyoteError(`window ${index}: frequency must be within ${FREQ_MIN_MS}..${FREQ_MAX_MS} ms`)
  }
  if (!Number.isFinite(window.intensity)) {
    throw new CoyoteError(`window ${index}: intensity must be finite`)
  }
  if (window.intensity < INTENSITY_MIN || window.intensity > INTENSITY_MAX) {
    throw new CoyoteError(`window ${index}: intensity must be within ${INTENSITY_MIN}..${INTENSITY_MAX}`)
  }
}

/** Encode exactly four windows into one 16-hex-character entry. */
export function encodeWaveEntry(windows: readonly WaveWindow[]): string {
  if (windows.length !== WINDOWS_PER_ENTRY) {
    throw new CoyoteError(`a waveform entry needs exactly ${WINDOWS_PER_ENTRY} windows`)
  }
  let hex = ''
  for (let i = 0; i < WINDOWS_PER_ENTRY; i += 1) {
    const window = windows[i]!
    assertWindow(window, i)
    hex += byteHex(compressFrequency(window.freqMs))
  }
  for (let i = 0; i < WINDOWS_PER_ENTRY; i += 1) {
    const window = windows[i]!
    hex += byteHex(Math.round(clamp(window.intensity, INTENSITY_MIN, INTENSITY_MAX)))
  }
  return hex
}

/** Decode one 16-hex-character entry into four windows. */
export function decodeWaveEntry(hex: string): WaveWindow[] {
  if (!/^[0-9a-fA-F]{16}$/.test(hex)) {
    throw new CoyoteError(`waveform entry must be 16 hex characters: ${hex}`)
  }
  const bytes: number[] = []
  for (let i = 0; i < 16; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  const windows: WaveWindow[] = []
  for (let i = 0; i < WINDOWS_PER_ENTRY; i += 1) {
    const freqCode = bytes[i]!
    const intensity = bytes[WINDOWS_PER_ENTRY + i]!
    if (freqCode < FREQ_CODE_MIN || freqCode > FREQ_CODE_MAX) {
      throw new CoyoteError(`waveform entry carries invalid frequency byte ${freqCode}: ${hex}`)
    }
    if (intensity < INTENSITY_MIN || intensity > INTENSITY_MAX) {
      throw new CoyoteError(`waveform entry carries invalid intensity byte ${intensity}: ${hex}`)
    }
    windows.push({ freqMs: expandFrequency(freqCode), intensity })
  }
  return windows
}

/** Check whether a string is a syntactically valid 16-hex waveform entry. */
export function isWaveEntryHex(value: string): boolean {
  return /^[0-9a-fA-F]{16}$/.test(value)
}

/** Encode a flat window list (multiple of 4) into protocol entries. */
export function encodeWaveSequence(windows: readonly WaveWindow[]): string[] {
  if (windows.length === 0) throw new CoyoteError('waveform sequence needs at least one window')
  if (windows.length % WINDOWS_PER_ENTRY !== 0) {
    throw new CoyoteError(`waveform sequence length must be a multiple of ${WINDOWS_PER_ENTRY}`)
  }
  const entries: string[] = []
  for (let i = 0; i < windows.length; i += WINDOWS_PER_ENTRY) {
    entries.push(encodeWaveEntry(windows.slice(i, i + WINDOWS_PER_ENTRY)))
  }
  return entries
}

/** Decode protocol entries back into a flat window list. */
export function decodeWaveSequence(entries: readonly string[]): WaveWindow[] {
  return entries.flatMap(entry => decodeWaveEntry(entry))
}

/**
 * Scale one entry's intensity bytes (0..100) by a percentage (0..100),
 * leaving frequency bytes untouched. 100 is the identity.
 */
export function scaleEntryIntensity(entry: string, percent: number): string {
  if (!isWaveEntryHex(entry)) {
    throw new CoyoteError(`waveform entry must be 16 hex characters: ${entry}`)
  }
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new CoyoteError('intensity scale must be within 0..100 percent')
  }
  let out = entry.slice(0, 8)
  for (let i = 8; i < 16; i += 2) {
    const value = Number.parseInt(entry.slice(i, i + 2), 16)
    out += byteHex(Math.round(clamp((value * percent) / 100, INTENSITY_MIN, INTENSITY_MAX)))
  }
  return out
}
