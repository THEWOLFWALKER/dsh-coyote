/**
 * Community waveform import: DG-Lab-Coyote-Game-Hub `.pulses` JSON, plain
 * Game-Hub-style object arrays, and bare hex lists.
 *
 * Format reference (openclaw-plugin-dg-lab ships the same three shapes):
 * - Game-Hub JSON: `[{"id":..,"name":"..","pulseData":["16hex",..]},..]`
 * - Bare hex: one waveform per file, entries separated by newlines/commas.
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { CoyoteError } from '../errors.ts'
import { isWaveEntryHex } from '../protocol/wave.ts'

/** One imported waveform, already validated. */
export interface ImportedWaveform {
  /** Display name (file name or JSON name). */
  name: string
  /** Protocol hex entries. */
  entries: string[]
  /** Source file the waveform came from, when loaded from disk. */
  source?: string
}

/** Default suggested intensity for imported waves (they carry no metadata). */
export const IMPORTED_SUGGESTED_PERCENT = 25

function normalizeEntries(raw: readonly string[]): string[] {
  const entries = raw.map(entry => entry.trim().toLowerCase()).filter(entry => entry.length > 0)
  for (const entry of entries) {
    if (!isWaveEntryHex(entry)) {
      throw new CoyoteError(`invalid waveform entry (need 16 hex characters): ${entry}`)
    }
  }
  if (entries.length === 0) throw new CoyoteError('waveform has no entries')
  return entries
}

interface GameHubRecord {
  id?: unknown
  name?: unknown
  pulseData?: unknown
}

/** Parse Game-Hub `.pulses` / JSON array text into imported waveforms. */
export function parseGameHubJson(text: string): ImportedWaveform[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new CoyoteError('Game-Hub waveform file is not valid JSON')
  }
  if (!Array.isArray(value)) throw new CoyoteError('Game-Hub waveform file must be a JSON array')
  const waves: ImportedWaveform[] = []
  value.forEach((record, index) => {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new CoyoteError(`Game-Hub entry ${index} is not an object`)
    }
    const { id, name, pulseData } = record as GameHubRecord
    if (!Array.isArray(pulseData) || pulseData.some(entry => typeof entry !== 'string')) {
      throw new CoyoteError(`Game-Hub entry ${index} has no string[] pulseData`)
    }
    const label = typeof name === 'string' && name.trim().length > 0
      ? name.trim()
      : typeof id === 'string' || typeof id === 'number' ? String(id) : `wave-${index + 1}`
    waves.push({ name: label, entries: normalizeEntries(pulseData as string[]) })
  })
  if (waves.length === 0) throw new CoyoteError('Game-Hub waveform file contains no waveforms')
  return waves
}

/** Parse a bare hex list (newline or comma separated) into one waveform. */
export function parseHexList(text: string, name: string): ImportedWaveform {
  const parts = text.split(/[\n,]+/)
  return { name, entries: normalizeEntries(parts) }
}

/** Parse one file by shape: JSON array means Game-Hub, otherwise bare hex. */
export function parseWaveformFile(text: string, fileName: string): ImportedWaveform[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    return parseGameHubJson(text).map(wave => ({ ...wave, source: fileName }))
  }
  const base = basename(fileName).replace(/\.[^.]+$/, '')
  return [{ ...parseHexList(text, base), source: fileName }]
}

/** Load every importable file under a directory (non-recursive, best effort). */
export async function loadWaveformDir(dir: string): Promise<ImportedWaveform[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const waves: ImportedWaveform[] = []
  for (const file of files) {
    if (!/\.(json|pulses|txt)$/i.test(file)) continue
    try {
      const text = await readFile(join(dir, file), 'utf8')
      waves.push(...parseWaveformFile(text, file))
    } catch {
      // A bad community file must not take the whole library down.
    }
  }
  return waves
}
