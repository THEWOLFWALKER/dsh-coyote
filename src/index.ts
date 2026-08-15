/**
 * DeepSeek Harness plugin: agent- and GUI-controlled DG-LAB Coyote e-stim.
 *
 * One safety envelope (`CoyoteRuntime`) serves two faces with equal bounds:
 * the eight model-facing `coyote_*` tools and the browser panel bridge on
 * the server's `/gui` WebSocket path. Neither face can bypass soft limits,
 * the asymmetric increase rate limiter, session cooldown, playback caps, or
 * the disconnect fail-safe.
 *
 * @module dsh-coyote
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { attachAutoStim } from './auto-stim/attach.ts'
import { AutoStimEngine } from './auto-stim/engine.ts'
import { EventMapper } from './auto-stim/mapper.ts'
import { autoStimSchema, normalizeAutoStimConfig, type AutoStimUserConfig } from './auto-stim/rules.ts'
import { GuiBridge } from './gui/bridge.ts'
import { CoyoteRuntime } from './runtime/runtime.ts'
import { createCoyoteTools } from './tools/index.ts'

export { CoyoteError } from './errors.ts'
export { attachAutoStim } from './auto-stim/attach.ts'
export { AutoStimEngine, type AutoStimStatus } from './auto-stim/engine.ts'
export { EventMapper } from './auto-stim/mapper.ts'
export {
  AUTO_STIM_EVENTS,
  DEFAULT_AUTO_STIM_RULES,
  DEFAULT_AUTO_STIM_SETTINGS,
  autoStimSchema,
  normalizeAutoStimConfig,
  type AutoStimConfig,
  type AutoStimEvent,
  type AutoStimRule,
  type AutoStimSettings,
  type AutoStimUserConfig,
} from './auto-stim/rules.ts'
export { GuiBridge } from './gui/bridge.ts'
export { CoyoteRuntime, STRENGTH_MAX, STRENGTH_MIN } from './runtime/runtime.ts'
export type {
  CoyoteRuntimeConfig,
  PlayWaveRequest,
  RuntimeStatus,
  StrengthResult,
  WaveSource,
} from './runtime/runtime.ts'
export { CoyoteServer } from './transport/server.ts'
export type { CoyoteServerOptions, SessionInfo } from './transport/server.ts'
export { createCoyoteTools } from './tools/index.ts'
export type { CoyoteToolsOptions } from './tools/index.ts'
export { composeWave } from './waveform/composer.ts'
export type { ComposeSpec } from './waveform/composer.ts'
export { BUILT_IN_WAVEFORMS } from './waveform/library.ts'

/** Cordis plugin name. */
export const name = 'dsh-coyote'

/** Harness services required by the model-facing consumer. */
export const inject = ['tools']

/** Complete deployment configuration; defaults are filled by Schemastery. */
export interface Config {
  /** WebSocket listen host. 0.0.0.0 binds every interface so LAN phones reach the QR URL. */
  host?: string
  /** WebSocket listen port. Default 9999 (the official demo backend port); 0 asks the OS. */
  port?: number
  /** QR WebSocket base URL override for reverse proxies, e.g. `wss://relay.example.com`. */
  publicWsUrl?: string
  /** Directory community waveform imports persist to (created on demand). */
  waveformDir?: string
  /** Agent-side strength cap for channel A (0..200). */
  softLimitA?: number
  /** Agent-side strength cap for channel B (0..200). */
  softLimitB?: number
  /** Seconds a new pairing must wait after the previous session ended; 0 disables. */
  sessionCooldownSec?: number
  /** Hard cap on one bound session in seconds; 0 disables. */
  maxSessionSec?: number
  /** Hard cap on one waveform playback in seconds. */
  maxPlaySec?: number
  /** Playback duration used when a tool call omits one. */
  defaultPlaySec?: number
  /** Sustained strength-increase speed in units/second. */
  increaseRatePerSec?: number
  /** Immediate strength-increase budget in units. */
  increaseBurst?: number
  /**
   * Event-driven auto-stim (v0.2). Disabled unless `autoStim.enabled` is
   * explicitly true; see README "Auto-stim" for the rule table.
   */
  autoStim?: AutoStimUserConfig
}

export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(9999),
  publicWsUrl: z.string(),
  waveformDir: z.string().default('coyote-waveforms'),
  softLimitA: z.number().default(100),
  softLimitB: z.number().default(100),
  sessionCooldownSec: z.number().default(3),
  maxSessionSec: z.number().default(3600),
  maxPlaySec: z.number().default(600),
  defaultPlaySec: z.number().default(30),
  increaseRatePerSec: z.number().default(40),
  increaseBurst: z.number().default(40),
  autoStim: autoStimSchema(),
})

/** Config after Schemastery defaults; only publicWsUrl and autoStim stay optional. */
type ResolvedConfig = Required<Omit<Config, 'publicWsUrl' | 'autoStim'>> & Pick<Config, 'publicWsUrl' | 'autoStim'>

/** Validate the resolved values the runtime cannot check itself. @internal */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = config as ResolvedConfig
  if (!(resolved.maxPlaySec > 0)) throw new Error('dsh-coyote: maxPlaySec must be > 0')
  if (!(resolved.defaultPlaySec > 0)) throw new Error('dsh-coyote: defaultPlaySec must be > 0')
  if (resolved.defaultPlaySec > resolved.maxPlaySec) {
    throw new Error('dsh-coyote: defaultPlaySec cannot exceed maxPlaySec')
  }
  if (resolved.port !== 0 && (!Number.isSafeInteger(resolved.port) || resolved.port < 1 || resolved.port > 65535)) {
    throw new Error('dsh-coyote: port must be 0 (OS-assigned) or a valid TCP port')
  }
  if (resolved.waveformDir.trim() === '') throw new Error('dsh-coyote: waveformDir cannot be empty')
  if (resolved.publicWsUrl !== undefined) {
    try {
      const protocol = new URL(resolved.publicWsUrl).protocol
      if (protocol !== 'ws:' && protocol !== 'wss:') throw new Error('unsupported protocol')
    } catch {
      throw new Error('dsh-coyote: publicWsUrl must be a ws:// or wss:// URL')
    }
  }
  return resolved
}

/** Register the eight coyote_* tools and mount the GUI bridge (+ auto-stim when enabled). */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const runtime = new CoyoteRuntime(
    {
      server: {
        host: resolved.host,
        port: resolved.port,
        ...(resolved.publicWsUrl === undefined ? {} : { publicWsUrl: resolved.publicWsUrl }),
      },
      waveformDir: resolved.waveformDir,
      softLimitA: resolved.softLimitA,
      softLimitB: resolved.softLimitB,
      sessionCooldownSec: resolved.sessionCooldownSec,
      maxSessionSec: resolved.maxSessionSec,
      maxPlaySec: resolved.maxPlaySec,
      increaseRatePerSec: resolved.increaseRatePerSec,
      increaseBurst: resolved.increaseBurst,
    },
    message => ctx.logger.info(`dsh-coyote: ${message}`),
  )

  // Auto-stim is opt-in: no listeners, no engine, no GUI section unless enabled.
  let autoStimEngine: AutoStimEngine | undefined
  if (resolved.autoStim?.enabled === true) {
    const autoStimConfig = normalizeAutoStimConfig(resolved.autoStim)
    autoStimEngine = new AutoStimEngine(
      runtime,
      autoStimConfig,
      message => ctx.logger.info(`dsh-coyote: ${message}`),
    )
    const mapper = new EventMapper({ tickIntervalSec: autoStimConfig.tickIntervalSec })
    attachAutoStim(ctx, mapper, autoStimEngine, message => ctx.logger.warn(`dsh-coyote: ${message}`))
  }

  const bridge = new GuiBridge(runtime, autoStimEngine)
  runtime.mountGui(socket => bridge.handleConnection(socket))
  const unsubscribeAutoStim = autoStimEngine?.subscribe(() => bridge.broadcast())

  ctx.effect(() => () => {
    unsubscribeAutoStim?.()
    autoStimEngine?.dispose()
    bridge.dispose()
    void runtime.dispose()
  }, 'dsh-coyote teardown')

  for (const tool of createCoyoteTools(runtime, {
    defaultPlaySec: resolved.defaultPlaySec,
    maxPlaySec: resolved.maxPlaySec,
    ...(autoStimEngine === undefined ? {} : { autoStim: autoStimEngine }),
  })) {
    ctx.tools.register(tool)
  }

  void runtime.start().then(
    address => ctx.logger.info(`dsh-coyote: transport ready on ${address.host}:${address.port} (panel path /gui)`),
    error => ctx.logger.error(`dsh-coyote: transport failed to start: ${String(error)}`),
  )
}
