import z from "@deepseek-ai/schemastery";
import { WebSocket } from "ws";
import { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
//#region src/errors.d.ts
/** Error type for invalid state, unsafe parameters, or protocol failures. */
declare class CoyoteError extends Error {
  readonly code?: string | undefined;
  /**
   * @param message - Actionable operator- or model-facing failure text.
   * @param code - Optional machine-readable tag, e.g. a V3 protocol error code.
   */
  constructor(message: string, code?: string | undefined);
}
//#endregion
//#region src/types.d.ts
/** Channel and state vocabulary shared by every layer of dsh-coyote. */
/** Physical output channel of the Coyote host. */
type Channel = 'A' | 'B';
/** Channel addressing accepted by tools and the GUI. */
type ChannelSelection = 'A' | 'B' | 'both';
/** Waveform playback mode. */
type PlayMode = 'once' | 'loop';
/** Connection lifecycle of the transport. */
type ConnectionState = 'idle' | 'waiting-app' | 'bound';
/**
 * Device-reported strengths in the raw 0-200 protocol domain.
 * Values arrive from the App as `strength-A+B+limitA+limitB` reports.
 */
interface DeviceStrength {
  /** Channel A current strength. */
  a: number;
  /** Channel B current strength. */
  b: number;
  /** Channel A hard limit configured on the App side. */
  limitA: number;
  /** Channel B hard limit configured on the App side. */
  limitB: number;
}
/** App-side icon feedback button index (A: 0-4, B: 5-9). */
interface AppFeedback {
  /** Zero-based button index in the range 0-9. */
  index: number;
  /** Channel the button belongs to. */
  channel: Channel;
}
//#endregion
//#region src/protocol/frames.d.ts
/** Strength action: 0 decrease, 1 increase, 2 set absolute. */
type StrengthAction = 0 | 1 | 2;
//#endregion
//#region src/waveform/scheduler.d.ts
/** Transport face the scheduler needs (implemented by the WS server). */
interface WaveTransport {
  /** Send one pulse segment to one channel. */
  sendPulse(channel: Channel, entries: readonly string[]): Promise<void>;
  /** Clear one channel's pending waveform queue. */
  clearPulse(channel: Channel): Promise<void>;
}
/** Result of a started playback. */
interface PlaySummary {
  /** Channels actually driven. */
  channels: Channel[];
  mode: PlayMode;
  durationSec: number;
  /** Number of wire segments scheduled for the first pass. */
  segments: number;
}
//#endregion
//#region src/transport/server.d.ts
/** Constructor options; every field has a protocol-derived default. */
interface CoyoteServerOptions {
  /** Listen host. Default binds every interface so LAN phones can reach it. */
  host?: string;
  /** Listen port. 0 (default) asks the OS for a free port. */
  port?: number;
  /** QR WebSocket base URL override, e.g. `wss://proxy.example.com`. */
  publicWsUrl?: string;
  /** Bind handshake timeout after the App socket opens (default 15s). */
  bindTimeoutMs?: number;
  /** Heartbeat interval while bound (official demo: 60s). */
  heartbeatIntervalMs?: number;
  /** Bindings for the QR data URL image. */
  qrWidth?: number;
}
/** Server-side event callbacks; all optional, none may throw. */
interface CoyoteServerHandlers {
  /** The App completed the DGLAB bind handshake. */
  onBound?: () => void;
  /** The App reported new channel strengths or limits. */
  onStrength?: (strength: DeviceStrength) => void;
  /** The App user tapped a feedback button. */
  onFeedback?: (feedback: AppFeedback) => void;
  /** A bound session ended (socket close, send failure, or teardown). */
  onDisconnect?: (reason: string) => void;
  /** Diagnostic log line. */
  onLog?: (message: string) => void;
}
/** Everything the GUI and tools need about the pairing session. */
interface SessionInfo {
  /** Our control-terminal id (32 hex chars, uuid-v4 shaped). */
  controlId: string;
  /** Exact QR text the App must scan. */
  qrPayload: string;
  /** Renderable `data:image/png;base64,…` QR image. */
  qrDataUrl: string;
}
/** Handler for browser-panel connections on the `/gui` path. */
type GuiConnectionHandler = (socket: WebSocket) => void;
/**
 * The merged socket server + control terminal. Implements `WaveTransport`
 * so the scheduler can drive it directly.
 */
declare class CoyoteServer implements WaveTransport {
  private readonly options;
  private readonly handlers;
  private wss;
  private session;
  private disposed;
  private guiHandler?;
  private readonly guiSockets;
  /** Latest device-reported strengths while bound. */
  strength?: DeviceStrength | undefined;
  constructor(options?: CoyoteServerOptions, handlers?: CoyoteServerHandlers);
  /** Current connection lifecycle state. */
  get state(): ConnectionState;
  /** Whether the App completed binding and the socket is open. */
  isBound(): boolean;
  /** Our control id for the active session, when one exists. */
  get controlId(): string | undefined;
  /**
   * Route `/gui` connections to the browser-panel bridge. Call once before
   * `start()`; the server tracks GUI sockets so teardown can close them.
   */
  setGuiHandler(handler: GuiConnectionHandler): void;
  /** Start listening. Safe to call once; resolves with the bound address. */
  start(): Promise<{
    host: string;
    port: number;
  }>;
  /**
   * Mint a pairing session (control id + QR). Idempotent while unbound:
   * calling again before the App binds returns the same session.
   */
  beginSession(): Promise<SessionInfo>;
  /** Send one strength command to the bound App. */
  sendStrength(channel: Channel, action: StrengthAction, value: number): Promise<void>;
  /** WaveTransport: one pulse segment (already capped at 100 by the caller). */
  sendPulse(channel: Channel, entries: readonly string[]): Promise<void>;
  /** WaveTransport: clear one channel's pending waveform queue. */
  clearPulse(channel: Channel): Promise<void>;
  /**
   * End the active session: notify a bound App with a break frame (209),
   * close the socket, and drop the QR. A fresh `beginSession` mints new ids.
   */
  endSession(): Promise<void>;
  /** Permanent teardown: end the session, drop GUI panels, stop listening. */
  dispose(): Promise<void>;
  private handleConnection;
  private handleMessage;
  private handleBind;
  private handleClose;
  private sendCommand;
  /** Write one frame; a send failure ends the session (fail-safe). */
  private write;
  private safeWrite;
  private closeSocket;
  private log;
}
//#endregion
//#region src/protocol/wave.d.ts
/** One 25 ms output window. */
interface WaveWindow {
  /** Output-unit period in milliseconds within 10..1000. */
  freqMs: number;
  /** Relative waveform intensity within 0..100. */
  intensity: number;
}
//#endregion
//#region src/waveform/composer.d.ts
/** Interpolation shapes supported by both the frequency and intensity axes. */
type Curve = 'linear' | 'sine' | 'pulse' | 'random';
/** One axis sweep from `from` to `to` over the spec duration. */
interface AxisSpec {
  /** Start value (inclusive). */
  from: number;
  /** End value (inclusive at t=1 for linear/sine; plateau for pulse). */
  to: number;
  /** Interpolation shape. */
  curve: Curve;
}
/** Rhythmic gating in addition to the two axes; omit for continuous output. */
interface DutyCycleSpec {
  /** Seconds of active output per cycle. */
  onSec: number;
  /** Seconds of silence (intensity 0) per cycle. */
  offSec: number;
}
/** Complete declarative waveform description. */
interface ComposeSpec {
  /** Frequency axis in milliseconds (10..1000). */
  freq: AxisSpec;
  /** Intensity axis (0..100). */
  intensity: AxisSpec;
  /** Total duration in seconds; must be positive. */
  durationSec: number;
  /** Optional on/off rhythm. */
  dutyCycle?: DutyCycleSpec;
}
/** Result of a synthesis run. */
interface ComposedWave {
  /** Flat window list (4 windows per 100 ms entry). */
  windows: WaveWindow[];
  /** Entry count when encoded (durationSec * 10). */
  entryCount: number;
}
/** Synthesize one waveform from its spec. */
declare function composeWave(spec: ComposeSpec, seed?: number): ComposedWave;
//#endregion
//#region src/waveform/importer.d.ts
/**
 * Community waveform import: DG-Lab-Coyote-Game-Hub `.pulses` JSON, plain
 * Game-Hub-style object arrays, and bare hex lists.
 *
 * Format reference (openclaw-plugin-dg-lab ships the same three shapes):
 * - Game-Hub JSON: `[{"id":..,"name":"..","pulseData":["16hex",..]},..]`
 * - Bare hex: one waveform per file, entries separated by newlines/commas.
 */
/** One imported waveform, already validated. */
interface ImportedWaveform {
  /** Display name (file name or JSON name). */
  name: string;
  /** Protocol hex entries. */
  entries: string[];
  /** Source file the waveform came from, when loaded from disk. */
  source?: string;
}
//#endregion
//#region src/runtime/runtime.d.ts
/** Strength domain bounds (0..200 per the socket protocol). */
declare const STRENGTH_MIN = 0;
declare const STRENGTH_MAX = 200;
/** Runtime configuration; all fields validated in the constructor. */
interface CoyoteRuntimeConfig {
  /** WebSocket listen options forwarded to the transport. */
  server?: CoyoteServerOptions;
  /** Directory of community waveform files (created on import). */
  waveformDir: string;
  /** Agent-side strength cap for channel A (0..200, default 100). */
  softLimitA?: number;
  /** Agent-side strength cap for channel B (0..200, default 100). */
  softLimitB?: number;
  /** Seconds a new pairing must wait after the last session ended (default 3, 0 disables). */
  sessionCooldownSec?: number;
  /** Hard cap on one bound session in seconds (default 3600, 0 disables). */
  maxSessionSec?: number;
  /** Hard cap on one playback in seconds (default 600). */
  maxPlaySec?: number;
  /** Sustained strength-increase speed in units/second (default 40). */
  increaseRatePerSec?: number;
  /** Immediate strength-increase budget in units (default 40). */
  increaseBurst?: number;
}
/** Full runtime snapshot for tools and the GUI. */
interface RuntimeStatus {
  state: ConnectionState;
  /** Active pairing session, when one exists. */
  session?: SessionInfo;
  /** Latest device-reported strengths, when bound. */
  strength?: DeviceStrength;
  /** Effective per-channel caps the runtime enforces right now. */
  effectiveLimitA: number;
  effectiveLimitB: number;
  /** Whether waveform playback is running on any channel. */
  playing: boolean;
  /** Seconds until pairing is allowed again (0 = now). */
  cooldownRemainingSec: number;
  /** Library sizes. */
  builtinCount: number;
  importedCount: number;
}
/** Result of one strength command. */
interface StrengthResult {
  channels: Channel[];
  /** Values actually sent (post-clamp), per channel. */
  applied: Record<Channel, number>;
  /** Values the caller asked for, per channel. */
  requested: Record<Channel, number>;
  /** Why values were reduced, when they were. */
  clampedBy?: ('soft-limit' | 'device-limit' | 'rate-limit')[];
}
/** Where a playback takes its entries from. */
type WaveSource = {
  kind: 'builtin';
  id: string;
} | {
  kind: 'imported';
  name: string;
} | {
  kind: 'hex';
  entries: string[];
} | {
  kind: 'spec';
  spec: ComposeSpec;
};
/** One playback request. */
interface PlayWaveRequest {
  source: WaveSource;
  channel: ChannelSelection;
  mode: PlayMode;
  durationSec: number;
  /** Scale waveform intensity bytes by 0..100 percent (default 100). */
  intensityScalePercent?: number;
  /** Mirror channel B (100 - x) when playing both. */
  mirrorB?: boolean;
}
/** Orchestrates transport, safety envelope, and waveform library. */
declare class CoyoteRuntime {
  private readonly config;
  private readonly log;
  private readonly server;
  private readonly scheduler;
  private readonly imported;
  private readonly limiters;
  private readonly baselines;
  private readonly listeners;
  private cooldownUntil;
  private sessionTimer?;
  constructor(config: CoyoteRuntimeConfig, log?: (message: string) => void);
  /** Start listening and preload the community waveform directory. */
  start(): Promise<{
    host: string;
    port: number;
  }>;
  /** Start (or return the pending) pairing session; enforces the cooldown. */
  pair(): Promise<SessionInfo>;
  /**
   * Subscribe to coarse state changes (connection, strength, playback,
   * library). Listeners run on the caller's stack and must not throw.
   * Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
  /** Route `/gui` WebSocket connections to the browser-panel bridge. */
  mountGui(handler: GuiConnectionHandler): void;
  /** Full snapshot for tools and the GUI. */
  status(): RuntimeStatus;
  /**
   * Set or adjust strength on one or both channels. Absolute `value` and
   * relative `delta` are mutually exclusive. Everything is clamped to the
   * effective limit and the increase limiter; decreases always pass.
   */
  setStrength(selection: ChannelSelection, request: {
    value?: number;
    delta?: number;
  }): Promise<StrengthResult>;
  /** Resolve a source, validate it, and hand it to the scheduler. */
  playWave(request: PlayWaveRequest): Promise<PlaySummary & {
    entryCount: number;
  }>;
  /** Stop waveform playback but keep channel strength as-is. */
  stopWave(): Promise<void>;
  /** Emergency stop: zero both strengths and clear both waveform queues. */
  panicStop(): Promise<void>;
  /** End the pairing session (cooldown applies afterwards). */
  endSession(): Promise<void>;
  /** List every playable waveform. */
  listWaveforms(): Array<{
    source: 'builtin' | 'imported';
    id: string;
    name: string;
    description: string;
    suggestedIntensityPercent: number;
    entryCount?: number;
  }>;
  /** Import community waveforms from text and persist them to the library dir. */
  importWaveform(text: string, fileName: string): Promise<ImportedWaveform[]>;
  /** Permanent teardown for plugin unload. */
  dispose(): Promise<void>;
  private resolveEntries;
  private onBound;
  private onStrength;
  private onDisconnect;
  /** Fan out a coarse change notification; listener errors are contained. */
  private notify;
  private armCooldown;
  private cooldownRemainingSec;
  private currentSession;
  private pairingInfo?;
  private get softLimitA();
  private get softLimitB();
  private effectiveLimit;
  private targets;
}
//#endregion
//#region src/gui/bridge.d.ts
/**
 * One bridge instance serves every connected panel. `broadcast` pushes the
 * same snapshot to all sockets, so two open panels never disagree.
 */
declare class GuiBridge {
  private readonly runtime;
  private readonly sockets;
  private unsubscribe;
  private lastImportedCount;
  constructor(runtime: CoyoteRuntime);
  /** Accept one panel socket; subscribes to runtime changes once globally. */
  handleConnection(socket: WebSocket): void;
  /** Drop every panel connection (plugin teardown). */
  dispose(): void;
  private dispatch;
  private playRequest;
  /** Push the new snapshot to every panel whenever the runtime changed. */
  private onRuntimeChange;
  private send;
}
//#endregion
//#region src/tools/index.d.ts
/** Options the descriptions need beyond the runtime itself. */
interface CoyoteToolsOptions {
  /** Playback duration used when the model omits one. */
  defaultPlaySec: number;
  /** Hard playback cap the runtime enforces. */
  maxPlaySec: number;
}
/** Build the eight coyote_* tool definitions around one runtime. */
declare function createCoyoteTools(runtime: CoyoteRuntime, options: CoyoteToolsOptions): ToolDefinition[];
//#endregion
//#region src/waveform/library.d.ts
/** One built-in waveform definition. */
interface BuiltInWaveform {
  /** Stable id used by tools and the GUI. */
  id: string;
  /** English display name. */
  name: string;
  /** Chinese display name. */
  nameZh: string;
  /** One-line description for the model and the GUI tooltip. */
  description: string;
  /** Suggested starting intensity in percent (0..100). */
  suggestedIntensityPercent: number;
  /** Declarative spec; windows are synthesized lazily and cached. */
  readonly spec: ComposeSpec;
}
/** All built-in waveform definitions (specs only, cheap to copy). */
declare const BUILT_IN_WAVEFORMS: readonly BuiltInWaveform[];
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "dsh-coyote";
/** Harness services required by the model-facing consumer. */
declare const inject: string[];
/** Complete deployment configuration; defaults are filled by Schemastery. */
interface Config {
  /** WebSocket listen host. 0.0.0.0 binds every interface so LAN phones reach the QR URL. */
  host?: string;
  /** WebSocket listen port. Default 9999 (the official demo backend port); 0 asks the OS. */
  port?: number;
  /** QR WebSocket base URL override for reverse proxies, e.g. `wss://relay.example.com`. */
  publicWsUrl?: string;
  /** Directory community waveform imports persist to (created on demand). */
  waveformDir?: string;
  /** Agent-side strength cap for channel A (0..200). */
  softLimitA?: number;
  /** Agent-side strength cap for channel B (0..200). */
  softLimitB?: number;
  /** Seconds a new pairing must wait after the previous session ended; 0 disables. */
  sessionCooldownSec?: number;
  /** Hard cap on one bound session in seconds; 0 disables. */
  maxSessionSec?: number;
  /** Hard cap on one waveform playback in seconds. */
  maxPlaySec?: number;
  /** Playback duration used when a tool call omits one. */
  defaultPlaySec?: number;
  /** Sustained strength-increase speed in units/second. */
  increaseRatePerSec?: number;
  /** Immediate strength-increase budget in units. */
  increaseBurst?: number;
}
declare const Config: z<Config>;
/** Config after Schemastery defaults; only publicWsUrl stays optional. */
type ResolvedConfig = Required<Omit<Config, 'publicWsUrl'>> & Pick<Config, 'publicWsUrl'>;
/** Validate the resolved values the runtime cannot check itself. @internal */
declare function resolveConfig(config: Config): ResolvedConfig;
/** Register the eight coyote_* tools and mount the GUI bridge. */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { BUILT_IN_WAVEFORMS, type ComposeSpec, Config, CoyoteError, CoyoteRuntime, type CoyoteRuntimeConfig, CoyoteServer, type CoyoteServerOptions, type CoyoteToolsOptions, GuiBridge, type PlayWaveRequest, type RuntimeStatus, STRENGTH_MAX, STRENGTH_MIN, type SessionInfo, type StrengthResult, type WaveSource, apply, composeWave, createCoyoteTools, inject, name, resolveConfig };