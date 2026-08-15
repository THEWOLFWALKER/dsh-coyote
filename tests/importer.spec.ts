import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoyoteError } from '../src/errors.ts'
import { loadWaveformDir, parseGameHubJson, parseHexList, parseWaveformFile } from '../src/waveform/importer.ts'

const ENTRY = '0a0a0a0a000a141e'

describe('importer', () => {
  it('parses Game-Hub JSON with names and ids', () => {
    const waves = parseGameHubJson(`[
      {"id": 1, "name": "Wave One", "pulseData": ["${ENTRY}"]},
      {"id": 2, "pulseData": ["${ENTRY}", "${ENTRY}"]}
    ]`)
    expect(waves).toHaveLength(2)
    expect(waves[0]!.name).toBe('Wave One')
    expect(waves[1]!.name).toBe('2')
    expect(waves[1]!.entries).toHaveLength(2)
  })

  it('rejects malformed Game-Hub files with actionable errors', () => {
    expect(() => parseGameHubJson('not json')).toThrow(/not valid JSON/)
    expect(() => parseGameHubJson('{"a":1}')).toThrow(/JSON array/)
    expect(() => parseGameHubJson('[{"name":"x"}]')).toThrow(/pulseData/)
    expect(() => parseGameHubJson(`[{"name":"x","pulseData":["zzz"]}]`)).toThrow(/16 hex/)
    expect(() => parseGameHubJson('[]')).toThrow(/no waveforms/)
  })

  it('parses bare hex lists with flexible separators and lowercases entries', () => {
    const wave = parseHexList(`${ENTRY.toUpperCase()}\n0a0a0a0a000a141e, ${ENTRY}`, 'list')
    expect(wave.entries).toEqual([ENTRY, ENTRY, ENTRY])
    expect(() => parseHexList('nope', 'bad')).toThrow(/16 hex/)
    expect(() => parseHexList(' , ', 'empty')).toThrow(/no entries/)
  })

  it('routes files by first character and attaches the source name', () => {
    const json = parseWaveformFile(`[{"id":9,"name":"N","pulseData":["${ENTRY}"]}]`, 'set.pulses')
    expect(json[0]!.source).toBe('set.pulses')
    const hex = parseWaveformFile(ENTRY, 'my wave.txt')
    expect(hex[0]!.name).toBe('my wave')
    expect(hex[0]!.source).toBe('my wave.txt')
  })

  it('loads a directory, skipping bad files without failing the batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coyote-waves-'))
    await writeFile(join(dir, 'good.json'), `[{"id":1,"name":"G","pulseData":["${ENTRY}"]}]`)
    await writeFile(join(dir, 'bad.json'), 'broken')
    await writeFile(join(dir, 'ignored.md'), 'skip me')
    const waves = await loadWaveformDir(dir)
    expect(waves).toHaveLength(1)
    expect(waves[0]!.name).toBe('G')
    expect(await loadWaveformDir(join(dir, 'missing'))).toEqual([])
  })

  it('surfaces parse errors as CoyoteError', () => {
    expect(() => parseHexList('xx', 'x')).toThrow(CoyoteError)
  })
})
