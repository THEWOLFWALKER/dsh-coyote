/**
 * The eight model-facing coyote_* tools.
 *
 * Design rules (mirroring dsh-toy):
 * - Tools are a thin, honest projection of the runtime: every destructive
 *   path already passed the safety envelope before the tool is called.
 * - Descriptions teach the safety model (0..200 domain, soft limits, rate
 *   limiting, cooldown, fail-safe) so the model behaves well without
 *   reading source code.
 * - Canonical outputs stay small and structured; `render` emits a compact
 *   text summary plus the full JSON so both the model and the GUI consume
 *   one contract.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CoyoteError } from '../errors.ts'
import type { AutoStimEngine } from '../auto-stim/engine.ts'
import type { ChannelSelection } from '../types.ts'
import type { CoyoteRuntime, WaveSource } from '../runtime/runtime.ts'
import { getBuiltIn } from '../waveform/library.ts'

/** Options the descriptions need beyond the runtime itself. */
export interface CoyoteToolsOptions {
  /** Playback duration used when the model omits one. */
  defaultPlaySec: number
  /** Hard playback cap the runtime enforces. */
  maxPlaySec: number
  /** Auto-stim engine whose status rides on coyote_status, when enabled. */
  autoStim?: AutoStimEngine
}

const STATES = ['idle', 'waiting-app', 'bound'] as const
const CHANNELS = ['A', 'B', 'both'] as const
const MODES = ['once', 'loop'] as const
const CURVES = ['linear', 'sine', 'pulse', 'random'] as const
const CLAMP_REASONS = ['soft-limit', 'device-limit', 'rate-limit'] as const

const AXIS_SCHEMA = (what: string) => ({
  type: 'object',
  required: true,
  additionalProperties: false,
  description: `${what} sweep from "from" (start) to "to" (end).`,
  properties: {
    from: { type: 'integer', required: true, description: 'Start value (inclusive).' },
    to: { type: 'integer', required: true, description: 'End value (inclusive).' },
    curve: { type: 'string', required: true, enum: CURVES, description: 'Interpolation shape between from and to.' },
  },
} as const)

const SESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Active pairing session.',
  properties: {
    controlId: { type: 'string', required: true },
    qrPayload: { type: 'string', required: true },
    qrDataUrl: { type: 'string', required: true },
  },
} as const

const DEVICE_STRENGTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Latest App-reported strengths and hard limits (0..200).',
  properties: {
    a: { type: 'integer', required: true },
    b: { type: 'integer', required: true },
    limitA: { type: 'integer', required: true },
    limitB: { type: 'integer', required: true },
  },
} as const

const AUTO_STIM_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Event-driven auto-stim block (absent fields mean "not applicable").',
  properties: {
    enabled: { type: 'boolean', required: true, description: 'False when autoStim is disabled in config.' },
    armed: { type: 'boolean', description: 'Runtime arm switch; false drops every event.' },
    maxIntensity: { type: 'integer', description: 'Auto-trigger strength cap (0..200).' },
    cooldownSec: { type: 'number', description: 'Minimum seconds between auto triggers.' },
    inFlight: { type: 'boolean', description: 'A pulse (including restore) is running.' },
    fired: { type: 'integer', description: 'Pulses delivered since plugin start.' },
    skipped: { type: 'integer', description: 'Events dropped by a gate (cooldown/busy/not-bound/disarmed).' },
    lastEvent: { type: 'string', description: 'Domain event of the last fired pulse.' },
    lastSkipReason: { type: 'string', description: '"<event>:<reason>" of the last dropped event.' },
    lastFiredAt: { type: 'number', description: 'Unix ms of the last fired pulse.' },
    cooldownRemainingSec: { type: 'number', description: 'Seconds until the next trigger is allowed.' },
  },
} as const

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', required: true, enum: STATES },
    session: SESSION_SCHEMA,
    strength: DEVICE_STRENGTH_SCHEMA,
    effectiveLimitA: { type: 'integer', required: true, description: 'Cap enforced on channel A right now.' },
    effectiveLimitB: { type: 'integer', required: true, description: 'Cap enforced on channel B right now.' },
    playing: { type: 'boolean', required: true },
    cooldownRemainingSec: { type: 'number', required: true },
    builtinCount: { type: 'integer', required: true },
    importedCount: { type: 'integer', required: true },
    autoStim: AUTO_STIM_STATUS_SCHEMA,
  },
} as const

const WAVEFORM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true, enum: ['builtin', 'imported'] },
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    suggestedIntensityPercent: { type: 'integer', required: true },
    entryCount: { type: 'integer' },
  },
} as const

const json = (value: unknown): string => JSON.stringify(value)

/**
 * Resolve a waveform name (built-in id or imported name) to a source.
 * Case-insensitive on both sides; throws with the full list on a miss.
 */
function resolveByName(runtime: CoyoteRuntime, name: string): WaveSource {
  const wanted = name.trim().toLowerCase()
  if (wanted.length === 0) throw new CoyoteError('waveform name cannot be empty')
  if (getBuiltIn(wanted) !== undefined) return { kind: 'builtin', id: wanted }
  const imported = runtime.listWaveforms().find(
    wave => wave.source === 'imported' && wave.id.toLowerCase() === wanted,
  )
  if (imported !== undefined) return { kind: 'imported', name: imported.name }
  throw new CoyoteError(
    `unknown waveform "${name}"; call coyote_waveforms with action "list" for the full list`,
  )
}

/** Build the eight coyote_* tool definitions around one runtime. */
export function createCoyoteTools(
  runtime: CoyoteRuntime,
  options: CoyoteToolsOptions,
): ToolDefinition[] {
  const defaultPlaySec = Math.min(options.defaultPlaySec, options.maxPlaySec)

  return [
    defineTool({
      name: 'coyote_status',
      description:
        'Snapshot of the Coyote link: connection state (idle / waiting-app / bound), the pairing session with its QR, latest device-reported channel strengths and App-side hard limits, the effective per-channel caps this runtime enforces, whether waveform playback is running, the remaining pairing cooldown, and (when autoStim is enabled in config) the auto-stim block: armed flag, fire/skip counters, and last trigger. Read this first in any uncertain situation; it never changes device output.',
      parameters: {},
      output: {
        schema: STATUS_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: json(value) }],
      },
      execute: async () => ({
        ...runtime.status(),
        ...(options.autoStim === undefined
          ? { autoStim: { enabled: false } }
          : { autoStim: options.autoStim.status() }),
      }),
      presentCall: () => ({ card: 'generic', title: 'Read Coyote status', kind: 'read' }),
    }),

    defineTool({
      name: 'coyote_pair',
      description:
        'Start (or return the pending) DG-LAB pairing session and get the QR payload + renderable QR image. The user must scan the QR with the official DG-LAB App on a phone that can reach this machine over the network. The session stays pending until the App binds; a cooldown may briefly reject an immediate re-pair after a previous session ended. Pairing alone changes no device output. Show the QR through the DSH coyote GUI panel, or have the user open the qrPayload with any QR generator.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            controlId: { type: 'string', required: true },
            qrPayload: { type: 'string', required: true },
            qrDataUrl: { type: 'string', required: true },
            state: { type: 'string', required: true, enum: STATES },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            `pairing session ${value.controlId} started (state: ${value.state})`,
            `qr payload: ${value.qrPayload}`,
            'Have the user scan this QR with the DG-LAB App; the QR image is rendered in the coyote GUI panel.',
          ].join('\n'),
        }],
      },
      execute: async () => {
        const session = await runtime.pair()
        return { ...session, state: runtime.status().state }
      },
      presentCall: () => ({ card: 'generic', title: 'Start Coyote pairing', kind: 'other' }),
    }),

    defineTool({
      name: 'coyote_disconnect',
      description:
        'End the pairing session: stop all waveform playback, zero both channel strengths, tell the bound App the relation is broken, and drop the QR. A short cooldown (configurable, default 3s) must pass before coyote_pair can start a new session. Prefer this over leaving a session dangling.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ended: { type: 'boolean', required: true },
            cooldownRemainingSec: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ended
            ? `session ended; cooldown ${value.cooldownRemainingSec}s before re-pairing`
            : json(value),
        }],
      },
      execute: async () => {
        await runtime.endSession()
        return { ended: true, cooldownRemainingSec: runtime.status().cooldownRemainingSec }
      },
      presentCall: () => ({ card: 'generic', title: 'End Coyote session', kind: 'other' }),
    }),

    defineTool({
      name: 'coyote_set_strength',
      description:
        'Set channel strength in the raw 0..200 protocol domain on channel A, B, or both. Pass either an absolute "value" or a relative "delta" (e.g. delta -10), never both. Safety envelope, applied before anything is sent: values are clamped to the per-channel soft limit and the App-side hard limit, and sustained increases pass an asymmetric rate limiter (decreases always go through immediately); the response reports what was actually applied and why it was reduced in "clampedBy". Start low (single digits) and increase gradually; ask the user before large jumps.',
      parameters: {
        channel: { type: 'string', required: true, enum: CHANNELS, description: 'Target channel; "both" drives A and B.' },
        value: { type: 'integer', description: 'Absolute target strength 0..200.' },
        delta: { type: 'integer', description: 'Change relative to the current strength, within ±200; requires a bound App.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            channels: { type: 'array', required: true, items: { type: 'string', enum: CHANNELS } },
            applied: {
              type: 'object',
              required: true,
              additionalProperties: false,
              description: 'Strength actually sent, per targeted channel.',
              properties: {
                A: { type: 'integer' },
                B: { type: 'integer' },
              },
            },
            requested: {
              type: 'object',
              required: true,
              additionalProperties: false,
              description: 'Strength the caller asked for, per targeted channel.',
              properties: {
                A: { type: 'integer' },
                B: { type: 'integer' },
              },
            },
            clampedBy: { type: 'array', items: { type: 'string', enum: CLAMP_REASONS } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.clampedBy === undefined
            ? `strength set on ${value.channels.join('+')}: ${Object.entries(value.applied).map(([ch, v]) => `${ch}=${v}`).join(' ')}`
            : `strength set on ${value.channels.join('+')}: ${Object.entries(value.applied).map(([ch, v]) => `${ch}=${v}`).join(' ')} (clamped by ${value.clampedBy.join(', ')})`,
        }],
      },
      execute: async args => {
        if (args.value === undefined && args.delta === undefined) {
          throw new CoyoteError('pass either value or delta')
        }
        return runtime.setStrength(args.channel as ChannelSelection, {
          ...(args.value === undefined ? {} : { value: args.value }),
          ...(args.delta === undefined ? {} : { delta: args.delta }),
        })
      },
      presentCall: args => ({
        card: 'generic',
        title: `Set Coyote strength ${args.channel}${args.value !== undefined ? ` to ${args.value}` : args.delta !== undefined ? ` by ${args.delta > 0 ? '+' : ''}${args.delta}` : ''}`,
        kind: 'other',
      }),
    }),

    defineTool({
      name: 'coyote_play_wave',
      description:
        `Play a waveform on channel A, B, or both. Exactly one source: "waveform" (a built-in preset id or an imported community name — call coyote_waveforms for the list), "spec" (a declarative synthesis: frequency sweep 10..1000ms and intensity sweep 0..100, each with a curve, plus optional on/off duty cycle), or "hex_entries" (raw 16-hex-character protocol entries). "intensity_percent" rescales the waveform's internal intensity bytes 0..100. "mirror" inverts channel B (100-x) when playing both. Playback self-terminates within "duration_seconds" (default ${defaultPlaySec}s, hard cap ${options.maxPlaySec}s); "loop" repeats the pattern until then. Strength (the 0..200 level) is a separate axis set by coyote_set_strength — a waveform still outputs nothing meaningful until the user has a comfortable strength level.`,
      parameters: {
        waveform: { type: 'string', description: 'Built-in preset id or imported community waveform name.' },
        spec: {
          type: 'object',
          additionalProperties: false,
          description: 'Declarative synthesis spec; alternative to waveform/hex_entries.',
          properties: {
            freq: AXIS_SCHEMA('Frequency axis in milliseconds (10..1000)'),
            intensity: AXIS_SCHEMA('Intensity axis in percent (0..100)'),
            durationSec: { type: 'number', required: true, description: 'Pattern length in seconds (pattern, not playback).' },
            dutyCycle: {
              type: 'object',
              additionalProperties: false,
              description: 'Optional rhythmic on/off gating.',
              properties: {
                onSec: { type: 'number', required: true, description: 'Seconds of output per cycle.' },
                offSec: { type: 'number', required: true, description: 'Seconds of silence per cycle.' },
              },
            },
          },
        },
        hex_entries: { type: 'array', items: { type: 'string' }, description: 'Raw protocol entries, each exactly 16 hex characters; alternative to waveform/spec.' },
        channel: { type: 'string', enum: CHANNELS, description: 'Target channel. Default A.' },
        mode: { type: 'string', enum: MODES, description: 'once plays the pattern once; loop repeats it. Default once.' },
        duration_seconds: { type: 'number', description: `Playback duration in seconds (default ${defaultPlaySec}, cap ${options.maxPlaySec}).` },
        intensity_percent: { type: 'integer', description: 'Scale the waveform intensity bytes by 0..100 percent. Default 100.' },
        mirror: { type: 'boolean', description: 'Invert channel B (100 - x) when channel is "both". Default false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            channels: { type: 'array', required: true, items: { type: 'string', enum: CHANNELS } },
            mode: { type: 'string', required: true, enum: MODES },
            durationSec: { type: 'number', required: true },
            segments: { type: 'integer', required: true },
            entryCount: { type: 'integer', required: true },
            source: { type: 'string', required: true, description: 'Which source was resolved and played.' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `playing ${value.source} on ${value.channels.join('+')} (${value.mode}, ${value.durationSec}s, ${value.entryCount} entries)`,
        }],
      },
      execute: async args => {
        const picked = [args.waveform, args.spec, args.hex_entries].filter(v => v !== undefined).length
        if (picked !== 1) {
          throw new CoyoteError('pass exactly one of waveform, spec, or hex_entries')
        }
        const source: WaveSource = args.waveform !== undefined
          ? resolveByName(runtime, args.waveform)
          : args.spec !== undefined
            ? { kind: 'spec', spec: args.spec }
            : { kind: 'hex', entries: args.hex_entries! }
        const sourceLabel = args.waveform !== undefined
          ? `${getBuiltIn(args.waveform.trim().toLowerCase()) !== undefined ? 'builtin' : 'imported'}:${args.waveform.trim()}`
          : args.spec !== undefined ? 'spec' : 'hex'
        const summary = await runtime.playWave({
          source,
          channel: (args.channel ?? 'A') as ChannelSelection,
          mode: (args.mode ?? 'once') as 'once' | 'loop',
          durationSec: args.duration_seconds ?? defaultPlaySec,
          ...(args.intensity_percent === undefined ? {} : { intensityScalePercent: args.intensity_percent }),
          ...(args.mirror === undefined ? {} : { mirrorB: args.mirror }),
        })
        return { ...summary, source: sourceLabel }
      },
      presentCall: args => ({
        card: 'generic',
        title: args.waveform !== undefined
          ? `Play Coyote wave ${args.waveform} on ${args.channel ?? 'A'}`
          : `Play Coyote wave ${args.spec !== undefined ? '(spec)' : '(hex)'} on ${args.channel ?? 'A'}`,
        kind: 'other',
      }),
    }),

    defineTool({
      name: 'coyote_stop_wave',
      description:
        'Stop waveform playback on both channels but keep the current channel strength. Use this to end a pattern without dropping the strength level; use coyote_panic_stop when output must stop immediately.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { stopped: { type: 'boolean', required: true } },
        },
        render: () => [{ type: 'text', text: 'waveform playback stopped; strength unchanged' }],
      },
      execute: async () => {
        await runtime.stopWave()
        return { stopped: true }
      },
      presentCall: () => ({ card: 'generic', title: 'Stop Coyote waveform', kind: 'other' }),
    }),

    defineTool({
      name: 'coyote_panic_stop',
      description:
        'Emergency stop: immediately clear both waveform queues and set both channel strengths to 0. Idempotent and safe in every state. Reach for this on any unexpected device reaction, user discomfort, or uncertainty — it never makes things worse.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { stopped: { type: 'boolean', required: true } },
        },
        render: () => [{ type: 'text', text: 'panic stop: waveforms cleared, both strengths at 0' }],
      },
      execute: async () => {
        await runtime.panicStop()
        return { stopped: true }
      },
      presentCall: () => ({ card: 'generic', title: 'Coyote PANIC STOP', kind: 'other' }),
    }),

    defineTool({
      name: 'coyote_waveforms',
      description:
        'Waveform library. action "list" returns every playable waveform (built-in presets with descriptions and suggested starting intensity, plus imported community waveforms) — the ids feed coyote_play_wave. action "import" parses Game-Hub `.pulses` JSON (an array of {name, pulseData}) or a bare hex list from "text" and persists it to the library, then returns the full updated list.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'import'] as const, description: 'List the library or import new waveforms from text.' },
        text: { type: 'string', description: 'File content to import (Game-Hub .pulses JSON or bare hex list); required for action "import".' },
        file_name: { type: 'string', description: 'Label for the imported file; used for bare-hex naming.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            imported: {
              type: 'array',
              description: 'Names persisted by action "import".',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  entryCount: { type: 'integer', required: true },
                },
              },
            },
            waveforms: { type: 'array', required: true, items: WAVEFORM_SCHEMA },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.imported === undefined
            ? `${value.waveforms.length} waveforms: ${value.waveforms.map(wave => wave.id).join(', ')}`
            : `imported ${value.imported.map(wave => wave.name).join(', ')}; library now ${value.waveforms.length} waveforms`,
        }],
      },
      execute: async args => {
        if (args.action === 'import') {
          if (args.text === undefined || args.text.trim().length === 0) {
            throw new CoyoteError('action "import" needs the file content in text')
          }
          const imported = await runtime.importWaveform(args.text, args.file_name ?? 'pasted.pulses')
          return {
            imported: imported.map(wave => ({ name: wave.name, entryCount: wave.entries.length })),
            waveforms: runtime.listWaveforms(),
          }
        }
        return { waveforms: runtime.listWaveforms() }
      },
      presentCall: args => ({
        card: 'generic',
        title: args.action === 'import' ? 'Import Coyote waveforms' : 'List Coyote waveforms',
        kind: args.action === 'import' ? 'other' : 'read',
      }),
    }),
  ]
}
