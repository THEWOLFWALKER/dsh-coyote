import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config, resolveConfig, type Config as ConfigType } from '../src/index.ts'

/** Fill every field the way Schemastery defaults would. */
function fullConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  return {
    host: '127.0.0.1',
    port: 0,
    publicWsUrl: undefined,
    waveformDir: 'waves',
    softLimitA: 100,
    softLimitB: 100,
    sessionCooldownSec: 0,
    maxSessionSec: 3600,
    maxPlaySec: 600,
    defaultPlaySec: 30,
    increaseRatePerSec: 40,
    increaseBurst: 40,
    ...overrides,
  } as ConfigType
}

/** Minimal cordis Context stand-in: records effect cleanups and tool rows. */
function makeCtx() {
  const cleanups: Array<() => void> = []
  const registered: Array<{ name: string }> = []
  const logs: string[] = []
  return {
    cleanups,
    registered,
    logs,
    ctx: {
      effect: (setup: () => () => void) => {
        cleanups.push(setup())
      },
      logger: { info: (message: string) => logs.push(message), error: (message: string) => logs.push(message) },
      tools: { register: (tool: { name: string }) => registered.push(tool) },
    } as unknown as Context,
  }
}

describe('plugin entry', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coyote-entry-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Config schema', () => {
    it('declares cordis metadata and fills defaults', () => {
      // The export shape the host loader reads before apply ever runs.
      const parsed = Config({}) as Record<string, unknown>
      expect(parsed.port).toBe(9999)
      expect(parsed.softLimitA).toBe(100)
      expect(parsed.sessionCooldownSec).toBe(3)
      expect(parsed.maxPlaySec).toBe(600)
      expect(parsed.defaultPlaySec).toBe(30)
    })

    it('accepts a full explicit config', () => {
      const parsed = Config({ port: 1234, softLimitA: 40, publicWsUrl: 'ws://relay:1' }) as Record<string, unknown>
      expect(parsed.port).toBe(1234)
      expect(parsed.softLimitA).toBe(40)
      expect(parsed.publicWsUrl).toBe('ws://relay:1')
    })
  })

  describe('resolveConfig', () => {
    it('passes a sane config through unchanged', () => {
      expect(resolveConfig(fullConfig())).toMatchObject({ port: 0, maxPlaySec: 600 })
    })

    it('rejects non-positive play budgets and inverted defaults', () => {
      expect(() => resolveConfig(fullConfig({ maxPlaySec: 0 }))).toThrow(/maxPlaySec/)
      expect(() => resolveConfig(fullConfig({ maxPlaySec: -5 }))).toThrow(/maxPlaySec/)
      expect(() => resolveConfig(fullConfig({ defaultPlaySec: 0 }))).toThrow(/defaultPlaySec/)
      expect(() => resolveConfig(fullConfig({ defaultPlaySec: 700 }))).toThrow(/exceed/)
    })

    it('rejects invalid ports and publicWsUrl protocols', () => {
      expect(() => resolveConfig(fullConfig({ port: 70_000 }))).toThrow(/port/)
      expect(() => resolveConfig(fullConfig({ port: -1 }))).toThrow(/port/)
      expect(() => resolveConfig(fullConfig({ publicWsUrl: 'http://nope' }))).toThrow(/publicWsUrl/)
      expect(() => resolveConfig(fullConfig({ publicWsUrl: 'not a url' }))).toThrow(/publicWsUrl/)
      expect(() => resolveConfig(fullConfig({ waveformDir: '  ' }))).toThrow(/waveformDir/)
    })
  })

  describe('apply', () => {
    it('registers the eight tools, mounts a teardown effect, and starts the transport', async () => {
      const { ctx, registered, cleanups, logs } = makeCtx()
      apply(ctx, fullConfig({ port: 0, waveformDir: dir }))

      expect(registered.map(tool => tool.name)).toEqual([
        'coyote_status',
        'coyote_pair',
        'coyote_disconnect',
        'coyote_set_strength',
        'coyote_play_wave',
        'coyote_stop_wave',
        'coyote_panic_stop',
        'coyote_waveforms',
      ])
      expect(cleanups).toHaveLength(1)
      await vi.waitFor(() => expect(logs.some(line => line.includes('transport ready'))).toBe(true))

      cleanups[0]!()
    })

    it('fails fast on config the runtime cannot honor', () => {
      const { ctx } = makeCtx()
      expect(() => apply(ctx, fullConfig({ defaultPlaySec: 0 }))).toThrow(/defaultPlaySec/)
      expect(() => apply(ctx, fullConfig({ maxPlaySec: -1 }))).toThrow(/maxPlaySec/)
    })
  })
})
