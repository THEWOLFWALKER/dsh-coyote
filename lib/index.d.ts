import z from "@deepseek-ai/schemastery";
import { WebSocket } from "ws";
import { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { Context, Service } from "@deepseek-ai/cordis";
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
//#region src/auto-stim/rules.d.ts
/** Every domain event auto-stim can react to. */
declare const AUTO_STIM_EVENTS: readonly ["turn_start", "assistant_start", "stream_tick", "tool_call", "tool_error", "agent_error", "turn_end_completed", "turn_end_aborted", "turn_end_max_tokens", "todo_clear", "agent_idle"];
type AutoStimEvent = (typeof AUTO_STIM_EVENTS)[number];
/** One event → stimulus rule. */
interface AutoStimRule {
  /** Whether this event triggers at all. */
  enabled: boolean;
  /** Built-in waveform id or imported waveform name (resolved at fire time). */
  waveform: string;
  /** Channel-strength target in the 0..200 domain; further clamped by `maxIntensity` and the runtime envelope. */
  intensity: number;
  /** Waveform playback length in seconds. */
  durationSec: number;
  /** Channels the pulse drives. */
  channel: ChannelSelection;
}
/** Global settings shared by every rule. */
interface AutoStimSettings {
  /** Extra hard cap applied on top of every rule intensity (1..200). */
  maxIntensity: number;
  /** Minimum seconds between two auto triggers (spam guard). */
  cooldownSec: number;
  /** Minimum seconds between two stream ticks while output streams. */
  tickIntervalSec: number;
  /** Restore the pre-pulse channel strength after each pulse. */
  restoreBaseline: boolean;
}
/** Fully normalized auto-stim configuration (every field resolved and valid). */
interface AutoStimConfig extends AutoStimSettings {
  rules: Record<AutoStimEvent, AutoStimRule>;
}
/** User-facing shape before normalization: everything optional, `events` loose. */
interface AutoStimUserConfig {
  enabled?: boolean;
  maxIntensity?: number;
  cooldownSec?: number;
  tickIntervalSec?: number;
  restoreBaseline?: boolean;
  events?: unknown;
}
/** Defaults for the global settings. */
declare const DEFAULT_AUTO_STIM_SETTINGS: AutoStimSettings;
/** The default rule table: tickle-level intensities, gentle waves, mostly on. */
declare const DEFAULT_AUTO_STIM_RULES: Record<AutoStimEvent, AutoStimRule>;
/**
 * Fill defaults, merge per-field overrides, and validate everything.
 * Unknown event names are rejected with the full valid list — a typo like
 * `tool_eror` must fail loudly at startup, not silently never fire.
 */
declare function normalizeAutoStimConfig(raw: unknown): AutoStimConfig;
/**
 * Schemastery schema for the deployment config. Leaf defaults mirror the
 * tables above for host-UI display; `events` stays loose (`z.any()`) because
 * normalizeAutoStimConfig is the single validation authority — a strict
 * nested schema could silently drop unknown keys (typos) before normalize
 * ever sees them.
 */
declare function autoStimSchema(): z<Schemastery.ObjectS<{
  enabled: z<boolean, boolean>;
  maxIntensity: z<number, number>;
  cooldownSec: z<number, number>;
  tickIntervalSec: z<number, number>;
  restoreBaseline: z<boolean, boolean>;
  events: z<any, any>;
}>, Schemastery.ObjectT<{
  enabled: z<boolean, boolean>;
  maxIntensity: z<number, number>;
  cooldownSec: z<number, number>;
  tickIntervalSec: z<number, number>;
  restoreBaseline: z<boolean, boolean>;
  events: z<any, any>;
}>>;
//#endregion
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
//#region src/auto-stim/engine.d.ts
/** Snapshot for tools, the GUI bridge, and tests. */
interface AutoStimStatus {
  enabled: true;
  /** Runtime arm switch (GUI toggle); disarmed drops every event silently. */
  armed: boolean;
  maxIntensity: number;
  cooldownSec: number;
  /** A pulse (including its restore) is running right now. */
  inFlight: boolean;
  fired: number;
  skipped: number;
  lastEvent?: AutoStimEvent;
  /** `<event>:<reason>` of the most recent dropped event. */
  lastSkipReason?: string;
  lastFiredAt?: number;
  cooldownRemainingSec: number;
}
declare class AutoStimEngine {
  private readonly runtime;
  private readonly config;
  private readonly log;
  private armed;
  private inFlight;
  private cooldownUntil;
  private fired;
  private skipped;
  private lastEvent?;
  private lastSkipReason?;
  private lastFiredAt?;
  private restoreTimer;
  private restoreResolve;
  /** The pulse currently between boost and restore; set before any device command. */
  private activePulse;
  private disposed;
  private readonly listeners;
  constructor(runtime: CoyoteRuntime, config: AutoStimConfig, log?: (message: string) => void);
  /** Entry point from the attach layer; synchronous, never throws. */
  handle(event: AutoStimEvent): void;
  /** GUI arm switch. A pulse already in flight still finishes (including restore). */
  setArmed(armed: boolean): void;
  /** Coarse change notification for the GUI bridge; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  status(): AutoStimStatus;
  /**
   * Permanent teardown: cancel the pending restore timer, cut an in-flight
   * pulse short (stopWave makes playWave return early), and restore the
   * pre-pulse strength immediately — teardown must never leave a boosted
   * level behind, whatever phase the pulse was in.
   */
  dispose(): void;
  private fire;
  /**
   * Resolve a rule's waveform name to a play source: built-in id first, then
   * imported waveform name (both case-insensitive). A miss throws, which the
   * handle() catch turns into a log line — a typo'd rule must not crash the
   * host, but it must be visible in the log.
   */
  private resolveWaveform;
  private restore;
  private waitRestore;
  private skip;
  private notify;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-scope@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-invariants_6f3351786c779449c277f079a737f571/node_modules/@deepseek-ai/dsh-scope/lib/types/index.d.ts
declare const ScopedBrand: unique symbol;
/**
 * A routing-only event receiver built by {@link scopeTarget}. The type
 * parameter records the subject type for dispatch checking; the carrier does
 * not expose the subject's properties. Event payloads carry the real subject.
 */
type Scoped<T extends object> = object & {
  readonly [ScopedBrand]: T;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-invariants_757bf6a984ac37281430ad822ab10469/node_modules/@deepseek-ai/dsh-brand/lib/types/index.d.ts
/**
 * The `Branded<B>` nominal-typing primitive — a type-only utility (no runtime
 * code, no harness-package dependency) shared by every package that owns a
 * cross-boundary id.
 *
 * A brand makes structurally-identical strings non-interchangeable at the type
 * level: a `SessionId` cannot be passed where a `CallId` is expected, even
 * though both are plain strings at runtime. Construction goes through a per-id
 * factory in the OWNING package (a plain cast inside — zero runtime cost);
 * comparison, logging, and serialization all behave as ordinary strings.
 *
 * Policy: a package brands the ids it owns — `CallId` in dsh-llm (tool-call
 * correlation), the shared agent/session `SessionId` in dsh-session, and
 * `JobId` in dsh-jobs. Branding is for ids that cross package boundaries and
 * could plausibly be confused; not every string needs a brand.
 * This package owns ONLY the primitive — no concrete id, no runtime code beyond
 * the (erased) type — so the brand vocabulary stays dependency-free and a
 * package can brand its ids without depending on an unrelated capability
 * package.
 *
 * @module @deepseek-ai/dsh-brand
 */
declare const BRAND: unique symbol;
/** A string carrying a compile-time-only brand `B`. */
type Branded<B extends string> = string & {
  readonly [BRAND]: B;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-brand_5463d1d16dfeb8cbf43fe361fb2eba74/node_modules/@deepseek-ai/dsh-attachment/lib/types/brand.d.ts
/** Opaque content-addressed identifier for one immutable attachment object. */
type AttachmentId = Branded<'AttachmentId'>;
/**
 * Brand a validated storage identifier.
 * @param value - backend-produced opaque identifier.
 * @returns the branded identifier.
 */
declare function AttachmentId(value: string): AttachmentId;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-brand_5463d1d16dfeb8cbf43fe361fb2eba74/node_modules/@deepseek-ai/dsh-attachment/lib/types/types.d.ts
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
/** Durable, serializable metadata for one immutable image object. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId;
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType;
  /** Exact encoded byte length. */
  bytes: number;
  /** Intrinsic encoded width in pixels. */
  width: number;
  /** Intrinsic encoded height in pixels. */
  height: number;
  /** Optional display name stripped of local path information. */
  name?: string;
}
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number;
  maxImagesPerMessage: number;
  maxMessageImageBytes: number;
  maxImagePixels: number;
  mediaTypes: readonly ImageMediaType[];
}
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array;
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType;
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string;
}
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef;
  data: Uint8Array;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-brand_5463d1d16dfeb8cbf43fe361fb2eba74/node_modules/@deepseek-ai/dsh-attachment/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore;
  }
}
/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
declare abstract class AttachmentStore extends Service {
  constructor(ctx: Context);
  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits;
  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>;
  /**
   * Validate and durably commit one image before its owning session event is appended.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns a durable content-addressed reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>;
  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and canonical reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/types/brand.d.ts
/** Stable identity carried by one message across inbox, log, and model-request boundaries. */
type MessageId = Branded<'MessageId'>;
/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string, branded; no validation is performed.
 */
declare function MessageId(id: string): MessageId;
/**
 * Correlates a model-issued tool call with its result. Provider-issued for
 * real adapters; synthesized by mocks/assembler fallbacks.
 */
type CallId = Branded<'CallId'>;
/**
 * Brand a string as a {@link CallId}.
 * @param id - the provider-issued (or synthesized) call id.
 * @returns the same string, branded; no validation is performed.
 */
declare function CallId(id: string): CallId;
/** Provider-issued request identifier retained for diagnostics across package boundaries. */
type ProviderRequestId = Branded<'ProviderRequestId'>;
/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; no validation is performed.
 */
declare function ProviderRequestId(id: string): ProviderRequestId;
/** Adapter-owned identifier for one model's selectable reasoning effort. */
type ReasoningEffortId = Branded<'ReasoningEffortId'>;
/**
 * Brand an adapter-owned reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model capability.
 * @returns the same string, branded; no validation is performed.
 */
declare function ReasoningEffortId(id: string): ReasoningEffortId;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts
/** Provider/model identity and adapter-private replay data for an assistant message. */
interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string;
  /** Provider model id that produced the message. */
  model: string;
  /**
   * Lossless-JSON adapter state needed to replay the provider response.
   * `LlmRuntime` exposes it to a target adapter only when that adapter instance
   * currently owns both this historical provider and the target provider.
   */
  replayState?: unknown;
}
/** Required source of an assistant message produced by a routed model. */
interface ModelMessageSource extends AssistantProvenance {
  kind: 'model';
}
/** Required source of a user-role message carrying one tool result. */
interface ToolMessageSource {
  kind: 'tool';
  callId: CallId;
}
/** One named contribution to a `snapshot`-form context, in assembly order. */
interface ContextSnapshotSection {
  /** The contributing subsystem's name. */
  readonly name: string;
  /** That contribution's model-facing text, exactly as assembled. */
  readonly text: string;
}
/**
 * Producer-declared {@link ContextForm} and the fields that form requires,
 * mixed into the source types that carry one.
 *
 * Discriminated by `form` so a producer cannot select a form without the
 * fields needed to present it: a `notice` must record its one-line
 * account, a `snapshot` its sections. Omitting `form` stays valid — an
 * undeclared context is the documented default.
 */
type ContextFormed = {
  readonly form?: never;
} | {
  readonly form: 'instructions';
} | {
  readonly form: 'catalog';
} | {
  readonly form: 'snapshot';
  /** The named contributions this snapshot assembled, in order. */
  readonly sections: readonly ContextSnapshotSection[];
} | {
  readonly form: 'notice';
  /** One-line account of what happened, shown without expanding the row. */
  readonly summary: string;
} | {
  readonly form: 'relay';
} | {
  readonly form: 'recall';
};
/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
interface MessageSourceMap {
  user: {
    kind: 'user';
  };
  plugin: {
    kind: 'plugin';
    plugin: string;
  } & ContextFormed;
  model: ModelMessageSource;
  tool: ToolMessageSource;
}
/** Any known message source, derived from {@link MessageSourceMap}; switch on `kind` and fall through unknowns (merge-extensible). */
type MessageSource = MessageSourceMap[keyof MessageSourceMap];
/** One immutable message representation shared by delivery, durable history, and model requests. */
interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId;
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant';
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[];
  /** Required source fields supplied by the producer. */
  readonly source: MessageSource;
}
/** A user-role specialization of the one shared message representation. */
interface UserMessage extends Message {
  readonly role: 'user';
}
/** A model-produced assistant specialization of the shared message representation. */
interface AssistantMessage extends Message {
  readonly role: 'assistant';
  readonly source: ModelMessageSource;
}
/** A tool-result specialization whose model-facing block retains call correlation. */
interface ToolResultMessage extends Message {
  readonly role: 'user';
  readonly content: [ToolResultBlock];
  readonly source: ToolMessageSource;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The provider topology changed: an adapter registered or unregistered
     * routes, or the configurable-provider directory gained or lost entries.
     * This payload-free registry notification fires at each commit point
     * (including registration disposal); consumers re-read `listProviders()`,
     * `listModels()`, or `listConfigurableProviders()` for the new state.
     * Observer failures are contained and cannot veto the registry mutation.
     * @mode emit
     */
    'llm/adapters-updated'(): void;
  }
}
/** Serializable provider or transport failure facts; policy decides whether they are retryable. */
interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string;
  /** Stable provider-neutral machine-routing code. */
  readonly code: string;
  /** HTTP status returned by the provider, when available. */
  readonly status?: number;
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number;
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: ProviderRequestId;
}
/** Plain text visible to the end user. */
interface TextBlock {
  type: 'text';
  text: string;
}
/** Reasoning / thinking content, distinct from visible text. */
interface ReasoningBlock {
  type: 'reasoning';
  text: string;
}
/**
 * A durable raster image reference, valid in user or assistant content. The
 * block is deliberately role-neutral; assistant-side rendering is forward
 * compatibility — the current production adapters declare text-only output,
 * so only user content carries images today.
 */
interface ImageBlock {
  type: 'image';
  /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
  attachment: ImageAttachmentRef;
}
/** A tool invocation requested by the model. */
interface ToolCallBlock {
  type: 'tool-call';
  /** Provider-issued call id; correlates with the matching tool result. */
  id: CallId;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
}
/** The result of a tool invocation, sent back to the model. */
interface ToolResultBlock {
  type: 'tool-result';
  toolCallId: CallId;
  content: ContentBlock[];
  isError?: boolean;
}
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support.
 */
interface ContentBlockMap {
  'text': TextBlock;
  'reasoning': ReasoningBlock;
  'image': ImageBlock;
  'tool-call': ToolCallBlock;
  'tool-result': ToolResultBlock;
}
/** The block `type` tag vocabulary; widens as plugins add entries to {@link ContentBlockMap}. */
type ContentBlockType = keyof ContentBlockMap;
/** Any known content block, derived from {@link ContentBlockMap}; switch on `type` and fall through unknowns (merge-extensible). */
type ContentBlock = ContentBlockMap[ContentBlockType];
/**
 * Why a model response stopped.
 * Merge-extensible so adapters can surface provider-specific reasons.
 */
interface FinishReasonMap {
  'stop': {
    kind: 'stop';
  };
  'tool-calls': {
    kind: 'tool-calls';
  };
  'max-tokens': {
    kind: 'max-tokens';
  };
  'aborted': {
    kind: 'aborted';
    failure: LlmFailure;
  };
  'error': {
    kind: 'error';
    failure: LlmFailure;
  };
}
/** Any known finish reason, derived from {@link FinishReasonMap}; switch on `kind` and fall through unknowns (merge-extensible). */
type FinishReason = FinishReasonMap[keyof FinishReasonMap];
/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
/** Display metadata for one registered provider route. */
interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string;
  /** Human-readable provider name for selectors and diagnostics. */
  name: string;
}
/** Merge-extensible provider model modality vocabulary. */
interface ModelModalityMap {
  text: 'text';
  image: 'image';
}
/** Any declared provider model modality. */
type ModelModality = ModelModalityMap[keyof ModelModalityMap];
/**
 * One provider route an adapter plugin can activate through configuration,
 * whether or not the route is currently registered. Configuration surfaces
 * merge this directory with `listProviders()` to offer every configurable
 * provider alongside its live/dormant state.
 */
interface LlmConfigurableProvider {
  /** Provider route key this entry activates when configured. */
  provider: string;
  /** Human-readable provider name for configuration surfaces. */
  displayName: string;
  /** User-settings namespace whose section configures this provider. */
  settingsNs: string;
  /**
   * Path from that namespace's section root to this provider's profile
   * object; empty when the whole section is the profile.
   */
  settingsPath: readonly string[];
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it — a gateway or self-hosted server it ships nothing about.
   * Absent means the adapter draws no such distinction; false means it does
   * and this route is one of its own. Only the adapter can answer: a stored
   * profile is how a user-added route AND a corrected shipped one both look
   * from outside.
   */
  declared?: boolean;
}
/**
 * One interrogation of a provider endpoint that configuration has not stored
 * yet. Configuration surfaces send the draft a user is still editing, so the
 * request carries the endpoint and credential directly instead of naming a
 * route: a provider being added has no route to name.
 */
interface LlmModelDiscoveryRequest {
  /**
   * Route the draft is editing, when it edits an existing one. A route whose
   * adapter already knows its models answers from that knowledge instead of
   * asking the endpoint — the adapter's own registry is the better answer, and
   * it costs no network call.
   */
  provider?: string;
  /**
   * Endpoint to interrogate. Optional because a route the adapter already
   * describes needs none; a route it does not must supply one.
   */
  baseURL?: string;
  /** Wire protocol the endpoint speaks, when the draft names one. */
  api?: string;
  /** Credential for this interrogation alone; the harness never stores it. */
  apiKey?: string;
  /** Caller cancellation; implementations must settle promptly after it aborts. */
  signal?: AbortSignal;
}
/**
 * One model an endpoint reports about itself. Every field but the id is
 * optional because most provider listings disclose an id and nothing else;
 * a surface adopting one of these still owes the capacities its adapter needs.
 */
interface LlmDiscoveredModel {
  /** Model id the endpoint accepts. */
  id: string;
  /** Human-readable name when the endpoint supplies one. */
  name?: string;
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number;
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number;
}
/** One adapter-discovered model; catalog membership is advisory, not request validation. */
interface LlmModelInfo {
  /** Provider route that owns this model entry. */
  provider: string;
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string;
  /** Human-readable model name for selectors. */
  name: string;
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string;
  /** Accepted request modalities; absent means unknown, while an explicit omission is negative capability. */
  inputModalities?: readonly ModelModality[];
}
/** Provider-owned context capacity for one exact provider/model route. */
interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number;
}
/** Display metadata for one adapter-owned reasoning effort. */
interface LlmReasoningEffortInfo {
  /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
  id: ReasoningEffortId;
  /** Human-readable effort name for selectors and diagnostics. */
  name: string;
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string;
}
/** Selectable reasoning efforts for one exact provider/model route. */
interface LlmModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly LlmReasoningEffortInfo[];
  /**
   * Adapter-configured default materialized into requests when callers omit
   * an effort. Absence preserves the provider's own default.
   */
  defaultEffort?: ReasoningEffortId;
}
/** Exact-route model metadata resolved by its owning adapter. */
interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: LlmModelContext;
  /** Adapter-configured per-request output cap materialized when callers omit one. */
  defaultMaxTokens?: number;
  /** Adapter-owned selectable reasoning levels when exposed. */
  reasoning?: LlmModelReasoningInfo;
}
/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. Adapters emit usage before the terminal finish and nothing
 * afterward; tool arguments remain raw JSON strings. An adapter implementation
 * may throw, but `LlmRuntime.stream()` normalizes that failure to a terminal
 * `error` or `aborted` finish before exposing it to consumers.
 */
type StreamChunk = {
  type: 'block-start';
  index: number;
  blockType: ContentBlockType;
} | {
  type: 'text-delta';
  index: number;
  text: string;
} | {
  type: 'reasoning-delta';
  index: number;
  text: string;
} | {
  type: 'tool-call-delta';
  index: number;
  id: CallId;
  name?: string;
  argumentsDelta: string;
} | {
  type: 'block-end';
  index: number;
  block: ContentBlock;
} | {
  type: 'usage';
  usage: TokenUsage;
} | {
  type: 'finish';
  reason: FinishReason;
  /** Adapter-private lossless-JSON state for replaying a successful response. */
  replayState?: unknown;
};
/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>;
}
/** A single model request, fully assembled. */
interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string;
  model: string;
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId;
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * the derived history (dsh-agent-loop); a hand-built one-shot passes any list.
   */
  messages: Message[];
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string;
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[];
  signal?: AbortSignal;
  /**
   * Session identity stamped by the loop for request routing. Replay uses it
   * to separate cursors; adapters may map it to model-hidden transport metadata.
   */
  sessionId?: Branded<'SessionId'>;
  /**
   * Provider-neutral classification for an auxiliary model call. Adapters may
   * map the purpose to model-hidden transport metadata or purpose-specific
   * generation policy. Ordinary conversation requests leave it unset.
   */
  purpose?: 'compaction' | 'session-title';
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/types/retry-policy.d.ts
/** Fully resolved backoff shared by both retry modes. */
interface ResolvedRetryBackoff {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}
/** Fully resolved bounded transient retry policy. */
interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'normal';
  readonly maxRetries: number;
  readonly retryableCodes: readonly string[];
}
/** Fully resolved unbounded retry policy. */
interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'always';
}
/** Immutable provider policy captured when its adapter route is registered. */
type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/types/call-config.d.ts
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
interface LlmCallConfig {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}
/**
 * Effective config fields supplied by exact-model adapter resolution rather
 * than by the caller's request proposal.
 */
interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true;
  maxTokens?: true;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmRuntime;
  }
  interface Events {
    /**
     * Waterfall around every streaming model call (retry, replay, routing).
     * Bound to the {@link LlmRuntime}; call `next()` to reach the resolved
     * adapter's stream, or yield your own chunks to short-circuit.
     * @param options - the full request. A LOOP-built request carries the
     *   process-local {@link markAgentLoopRequest} identity and arrives deep-frozen
     *   (mutation throws): its content is a pure function of the session log (the
     *   reconstructability Agent Note), so listeners read it, never rewrite it.
     *   Hand-built calls do not carry that marker; their messages already obey
     *   the immutable creation contract.
     * @mode waterfall
     */
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>;
  }
}
/** One model call whose config and adapter registration were resolved together. */
interface PreparedLlmCall {
  /** Detached, deep-frozen config with any adapter-owned default materialized. */
  readonly config: LlmCallConfig;
  /** Immutable retry policy captured with the adapter registration. */
  readonly retryPolicy: ResolvedRetryPolicy;
  /** Detached context metadata resolved with the registration-bound call. */
  readonly context?: LlmModelContext;
  /** Config fields materialized by the captured adapter rather than proposed by the caller. */
  readonly adapterDefaults: LlmCallConfigAdapterDefaults;
  /**
   * Dispatch this call once through the registration captured during
   * preparation. The request's call-config fields must match {@link config};
   * reuse or mismatch fails with `INVALID_PREPARED_CALL`.
   * @param options - fully assembled request carrying the prepared config.
   * @returns the chunk stream, including the `llm/stream` waterfall.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request or library header hook. The direct-fetch
 * DeepSeek and library-backed pi-ai adapters meet this contract through different internals.
 */
declare abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo;
  /**
   * Return the provider-owned retry policy captured with this route.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @returns a resolved policy, or `undefined` to use the normal defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
  /**
   * Resolve all metadata available for one exact model. This query is
   * independent of the advisory catalog and does not validate request routing.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id passed to {@link GenerateOptions.model}.
   * @param _signal - cancellation for this exact-model lookup; asynchronous
   *   implementations must settle promptly after it aborts.
   * @returns provider/model identity plus any context, call-default, and reasoning metadata.
   */
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * What {@link LlmRuntime.registerAdapter} returns: the disposer, plus an
 * atomic route replacement for the same adapter instance.
 */
interface AdapterRegistrationHandle {
  /** Release every route this registration currently holds. */
  (): void;
  /**
   * Replace this registration's routes with `providers`, keeping the same
   * adapter instance. The candidate set is validated in full first — a
   * conflict with another adapter, an invalid name, or bad provider metadata
   * throws and leaves the current routes untouched — and the swap itself is
   * one synchronous section, so no request can observe a gap. An empty array
   * is legal here (a settings section that emptied holds zero routes while
   * staying registered), unlike an empty initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been released: its routes are gone and its disposer has already run,
   * so anything registered afterwards would have no owner left to release it.
   * @param providers - the complete next route set for this registration.
   */
  replace(providers: string[]): void;
}
/**
 * A live configurable-provider registration, disposable and atomically
 * replaceable — the directory counterpart of {@link AdapterRegistrationHandle}.
 */
interface DirectoryRegistrationHandle {
  /** Withdraw every entry this registration currently holds. */
  (): void;
  /**
   * Replace this registration's entries with `entries`. The candidate set is
   * validated in full first — an entry another registration already declares,
   * a duplicate within the set, or invalid metadata throws and leaves the
   * current entries untouched — and the swap is one synchronous section, so no
   * reader observes a gap. An empty array is legal here, unlike an empty
   * initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been disposed.
   */
  replace(entries: readonly LlmConfigurableProvider[]): void;
}
/**
 * The abstract `llm` service: an adapter registry plus a streaming model-call
 * API, interceptable via the `llm/stream` waterfall.
 */
declare class LlmRuntime extends Service {
  private adapters;
  private directory;
  private discoveries;
  constructor(ctx: Context);
  /** Notify topology observers without letting one broken listener veto the commit. */
  private emitAdaptersUpdated;
  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnAdaptersListenerFailure;
  /**
   * Register an adapter for the given provider routes. Throws `LlmError` with code
   * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
   * Disposed with the fiber.
   * @param providers - every provider route this adapter should serve.
   * @param adapter - the adapter that streams calls for those providers.
   * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle;
  /**
   * Validate one candidate route set for `adapter`, treating routes this
   * registration already holds as available. Nothing is mutated: a rejected
   * candidate leaves the registry exactly as it was.
   */
  private prepareRoutes;
  /**
   * Swap this registration's routes for the prepared ones in one synchronous
   * section, so no observer can see the registry between the release and the
   * re-registration. The route set's one mutation point is also where
   * `llm/adapters-updated` is published, so a `replace` announces itself
   * exactly like a first registration.
   */
  private commitRoutes;
  /**
   * Describe provider routes with a registered adapter.
   * @returns detached provider metadata in registration order.
   */
  listProviders(): LlmProviderInfo[];
  /**
   * Declare provider routes an adapter plugin can activate through
   * configuration. Registration is all-or-nothing: an empty list, invalid
   * entry, or a provider already declared by any registration throws
   * `LlmError` without registering the rest. Disposed with the fiber.
   * @param entries - every configurable provider this plugin owns.
   * @returns a handle that withdraws all of them, and can atomically replace them.
   */
  registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle;
  /**
   * List every declared configurable provider, registered or dormant.
   * @returns detached directory entries in declaration order.
   */
  listConfigurableProviders(): LlmConfigurableProvider[];
  /**
   * Offer to interrogate provider endpoints on behalf of the settings
   * namespace this plugin owns. The namespace is the key because that is what
   * a configuration surface already holds from the configurable-provider
   * directory, and because a provider being *added* has no route to name yet.
   * Disposed with the fiber.
   * @param settingsNs - the namespace whose profiles this discovery serves.
   * @param discover - interrogates one endpoint; must honor `request.signal`.
   * @returns the disposer that withdraws the offer.
   */
  registerModelDiscovery(settingsNs: string, discover: (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>): () => void;
  /**
   * Interrogate one provider endpoint for the models it advertises. The
   * request describes a draft, not a stored route, so nothing here reads or
   * writes settings or credentials — the caller owns both, and the reply is
   * candidate metadata a surface may offer for adoption.
   * @param settingsNs - namespace whose registered discovery serves this draft.
   * @param request - the endpoint, protocol, and one-shot credential to use.
   * @returns the advertised models, deduplicated in endpoint order.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]>;
  /**
   * Resolve the retry policy captured when one provider route was registered.
   * @param provider - registered provider route to inspect.
   * @returns the provider-owned policy, with normal defaults already resolved.
   */
  providerRetryPolicy(provider: string): ResolvedRetryPolicy;
  /** Detach typed adapter-owned modality metadata. */
  private detachedModalities;
  /**
   * Discover models advertised by one registered provider. Catalog membership
   * is advisory and never changes routing or request validation.
   * @param provider - registered provider route to inspect.
   * @returns detached model metadata in adapter-preferred order.
   */
  listModels(provider: string): Promise<LlmModelInfo[]>;
  /**
   * Resolve and validate all metadata from the adapter that owns one exact
   * route. The result is detached from adapter-owned objects; catalog
   * membership remains advisory and does not control request routing.
   * @param provider - registered provider route to inspect.
   * @param model - exact model id passed to the adapter.
   * @param signal - optional cancellation for adapter-owned asynchronous lookup.
   * @returns exact model identity plus available context and reasoning metadata.
   */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  private resolveModelInfoFor;
  /**
   * Validate a conversation call config against its exact model capability and
   * materialize adapter-configured defaults. Unsupported explicit efforts
   * reject before provider I/O; no clamping or aliasing is performed. This
   * standalone query does not bind a later dispatch; use {@link prepareCall}
   * when logging and streaming must share one adapter registration.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a detached config only when a default must be materialized.
   */
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>;
  private resolveCallFor;
  /**
   * Resolve one call under its current adapter registration. The returned
   * one-shot handle keeps that registration across header logging and dispatch,
   * so HMR cannot combine one adapter's capability result with another adapter.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a prepared config and its registration-bound stream entry point.
   */
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>;
  private registration;
  /** Remove replay state whose historical route is owned by another adapter. */
  private forAdapter;
  /**
   * Final adapter boundary. Adapter selection, dispatch, iterator construction,
   * and iteration failures become one terminal failure chunk. Middleware and
   * downstream consumer failures remain thrown plugin or consumer errors.
   */
  private adapterStream;
  /**
   * Stream one model call as raw chunks (token-level deltas). Replay state is
   * retained only when the same adapter instance owns its historical provider
   * and the target provider. Final adapter selection remains fixed through
   * asynchronous exact-model resolution and dispatch. Adapter selection,
   * dispatch, and iteration failures become terminal `error` or `aborted`
   * finish chunks; middleware, nested-call, cleanup, and consumer failures
   * remain thrown.
   * @param options - the full request; `options.provider` selects the adapter.
   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  private streamWithRegistration;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.0-rc.6_6fd26f59436a18b115f326d6060415e6/node_modules/@deepseek-ai/dsh-session/lib/types/json.d.ts
/** Lossless-JSON validation and detached snapshots for durable session data. @module @deepseek-ai/dsh-session/json */
/**
 * A value that round-trips losslessly through JSON: `null`, a boolean, a finite
 * number other than negative zero, a string, an array of such values, or a
 * plain object whose values are such values. Arrays may carry only their dense
 * indexed elements; extra own properties would be discarded by JSON. TypeScript
 * cannot distinguish `-0` from `number`, so {@link isJsonValue} and
 * {@link snapshotJsonValue} enforce these details at runtime. Use this type for
 * a payload that must survive session-log persistence and replay byte-identically
 * — e.g. a tool's private presentation `meta`.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.0-rc.6_6fd26f59436a18b115f326d6060415e6/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts
/** Identifies one session in the store (and its persistence artifacts). */
type SessionId = Branded<'SessionId'>;
/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
declare function SessionId(id: string): SessionId;
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  readonly version: number;
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId;
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number;
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string;
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId;
  /**
   * How many leading events were inherited through a seed. Persisting this
   * boundary lets resume and replay distinguish parent history from child work.
   */
  readonly seedLength?: number;
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent';
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number;
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string;
}
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[];
  /**
   * Storage metadata read once before publication. `seedLength` is explicit
   * because a resumed seed contains the full stored log, not only its inherited prefix.
   */
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly createdAt?: number;
    readonly seedLength?: number;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
}
/**
 * Fresh storage values transferred to {@link SessionStore.prepare} without a
 * second serialization copy. Callers retain no mutable aliases.
 */
interface RestoredSessionOptions {
  /** Fresh detached storage events to validate and freeze in place. */
  readonly seed: SessionEvent[];
  /** Fresh detached storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader;
  /** Select the persistence ownership-transfer path. */
  readonly seedSource: 'persistence';
}
/** Inputs accepted while constructing an unpublished Session. */
type PrepareSessionOptions = (CreateSessionOptions & {
  readonly seedSource?: undefined;
}) | RestoredSessionOptions;
/** Why an active agent driver was cancelled. */
type AgentCancelCause = {
  readonly kind: 'user';
} | {
  readonly kind: 'parent';
} | {
  readonly kind: 'hook';
  readonly reason: string;
} | {
  readonly kind: 'disposed';
};
/** Durable cancellation cause, including imports whose original coarse record carried no cause. */
type TurnEndCancelCause = AgentCancelCause | {
  readonly kind: 'legacy';
};
/**
 * Why a turn ended. Merge-extensible sum type.
 */
interface TurnEndReasonMap {
  completed: {
    kind: 'completed';
  };
  /** A cancellation request interrupted the live turn. */
  aborted: {
    kind: 'aborted';
    reason: TurnEndCancelCause;
  };
  blocked: {
    kind: 'blocked';
  };
  /**
   * The turn failed. `error` is always a structured failure: the `LlmError`
   * facts verbatim, or `{ message: errorChain(error), code: 'UNKNOWN' }`
   * flattened from any other error.
   */
  error: {
    kind: 'error';
    error: LlmFailure;
  };
  /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
  'max-tokens': {
    kind: 'max-tokens';
  };
  /**
   * A persistence backend closed a crash-orphaned turn on reload. The loop never
   * emits this marker, and the events recorded before the crash remain intact.
   */
  interrupted: {
    kind: 'interrupted';
  };
}
/** The union over {@link TurnEndReasonMap} — why a turn ended; plugins extend it by merging variants into the map. */
type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap];
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * {@link SessionEventMap} event's whole-list snapshot.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string;
  /** Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several. */
  status: 'pending' | 'in_progress' | 'completed';
}
/**
 * Logged request state outside derived history: call config, system prompt, and
 * tools. The latest full `request/header` snapshot reconstructs it; canonical
 * empty optional fields are absent.
 */
interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  config: LlmCallConfig;
  /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
  adapterDefaults?: LlmCallConfigAdapterDefaults;
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string;
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[];
}
/** Registration-bound metadata for one resolved model route. */
interface RequestContext {
  /** Registered provider route the metadata belongs to. */
  provider: string;
  /** Provider-owned model id the metadata belongs to. */
  model: string;
  /** Maximum combined request and response context in tokens, when advertised. */
  contextWindow?: number;
}
/**
 * Why a `request/header` snapshot was appended: `'initial'` — the log's first
 * header (a new conversation); `'resume'` — a loop instance's first request
 * over a log that already has header events (process restart, fork seed);
 * `'change'` — a later request used a different header.
 */
type RequestHeaderReason = 'initial' | 'resume' | 'change';
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
interface SessionEventMap {
  /**
   * Opens turn `turn` before the loop claims queued input or runs pre-step.
   * Rejection, empty input, cancellation, or failure may close it with no
   * step; otherwise the following identified `user/message` event or batch
   * records the messages entering the step.
   */
  'turn/start': {
    turn: number;
  };
  /**
   * Closes turn `turn` with the {@link TurnEndReason} that ended it. A turn
   * with no entered step has no `step/start` or `step/end`. The loop does not await a
   * flush at turn boundaries: `dsh-session-checkpoint-policy` owns the
   * per-request durability checkpoint, and consumers that read storage after
   * `whenIdle()` flush themselves. Success commits the turn; rejection is
   * reported live and does not prevent later work.
   */
  'turn/end': {
    turn: number;
    reason: TurnEndReason;
  };
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': {
    turn: number;
    step: number;
  };
  /** Closes step `step` of turn `turn`. */
  'step/end': {
    turn: number;
    step: number;
  };
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an entered goal continuation round. All three
   * project their `content` verbatim; `source` tells them apart.
   */
  'user/message': UserMessage;
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': {
    turn: number;
    step: number;
    chunk: StreamChunk;
  };
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none.
   */
  'assistant/message': {
    turn: number;
    step: number;
    message: AssistantMessage;
    usage?: TokenUsage;
  };
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  'tool/call': {
    turn: number;
    step: number;
    callId: CallId;
    name: string;
    arguments: string;
  };
  /**
   * A completed tool call's model-facing result, optional internal failure
   * identity, and optional tool-private `meta` presentation payload. `meta` is
   * opaque to the core (the producing tool owns its shape and reads it back in
   * `presentResult`) but MUST be JSON-serializable: `Session.append`
   * runtime-validates all event data with `isJsonValue`, so a non-serializable
   * `meta` is rejected at the source, and the durable log reproduces the
   * identical card on replay. Absent
   * unless the tool attaches one (e.g. `dsh-tool-fs` carries its result-time
   * contextual diff here).
   */
  'tool/result': {
    turn: number;
    step: number;
    message: ToolResultMessage;
    error?: {
      name: string;
      code: string;
    };
    meta?: JsonValue;
  };
  /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
  'todo/write': {
    todos: TodoItem[];
  };
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  'request/header': {
    header: EpochHeader;
    reason: RequestHeaderReason;
  };
  /**
   * Route metadata for the next request, logged only when the route or capacity
   * changes. It does not participate in request reconstruction or header equality.
   */
  'request/context': RequestContext;
  /**
   * Marks the end of a constructor seed. Events before it have smaller seq
   * values and came from the seed (resume, fork, or replay); this lifecycle
   * produced none of them. This log-only event is the durable projection of
   * {@link Session.firstLiveSeq}. Its payload is empty — position and `time`
   * carry the meaning.
   *
   * Locate the LAST one in stored history. A seed already ending in one is not
   * re-marked, so reopening an untouched session does not grow its log per
   * pickup and the event need not be at the current `firstLiveSeq`.
   *
   * `Session`'s constructor is the only legitimate writer. The invariant
   * companion deliberately constrains nothing here, so a plugin appending one
   * would silently classify every live bracket before it as seed history.
   *
   * An owner of a standalone open/close bracket (`compaction/start` …
   * `compaction/end`) reads it because seed history and live work are otherwise
   * byte-identical: an unmatched opening marker before this event belongs to
   * an ended lifecycle, whatever ended it. NOT a liveness signal about other
   * writers — a concurrently live session holds its own boundary elsewhere,
   * so tolerating concurrent writers needs a signal beyond the log.
   */
  'session/end-seed': Record<string, never>;
}
/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
type SessionEventType = keyof SessionEventMap;
/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp} and {@link SessionEvent.sourceEventSeqs}.
 */
type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result';
/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool
 *   messages.
 * - `{ op: 'replace', start, end }`: replaces surface nodes from `start`
 *   (inclusive) through `end` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `start === end` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction; any surface-replacing producer
 *   may use it.
 */
type SurfaceOp = 'append' | {
  op: 'replace';
  start: number;
  end: number;
};
/**
 * Surface placement and cited source-event seqs for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
interface SurfaceIntent {
  surfaceOp: SurfaceOp;
  /**
   * Complete set of known source-event seqs. `assistant/message` may use a
   * present empty array for a known empty provider stream; when the field is
   * absent, the event does not record which earlier events produced the message.
   * Other surface events require a non-empty set when this field is present.
   */
  sourceEventSeqs?: number[];
}
/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`).
 * Non-surface events (boundary markers, chunks, usage, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
type SessionEvent<T extends SessionEventType = SessionEventType> = { [K in SessionEventType]: {
  type: K;
  /** Monotonic sequence number within the session. */
  seq: number;
  /** Unix epoch milliseconds. */
  time: number;
  data: SessionEventMap[K];
  /**
   * Marks an event a reader may safely skip when it does not recognize
   * `type`. Absent means required: a reader meeting an unrecognized type
   * without this marker MUST refuse to reconstruct the session instead of
   * silently dropping the event, because an unrecognized required event may
   * change how the rest of the log is interpreted. A writer sets `true` only
   * on purely informational records whose loss cannot affect reconstruction;
   * defaulting to required means a forgotten marker over-refuses (an
   * inconvenience) rather than silently resuming a gutted session.
   */
  ignorable?: true;
} & (K extends SurfaceEventType ? {
  /**
   * Seq numbers of earlier events that this event cites as sources
   * (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
   * or the surface nodes shadowed by a compaction replace node). An
   * `assistant/message` may carry a present empty array for a known empty
   * provider stream; when the field is absent, the event does not record which
   * earlier events produced the message.
   */
  sourceEventSeqs?: number[];
  /** How this event entered the surface; absent for non-surface events. */
  surfaceOp?: SurfaceOp;
} : object); }[T];
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-typert-protocol@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-_ee0216bcd98c4ea06ecb5223639c3e04/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts
declare const LOOKUP_HOST: unique symbol;
declare const LOOKUP_WIRE: unique symbol;
declare const CONTEXT_WIRE: unique symbol;
/** Type-level association between a Host object and its wire identity. */
interface TypertLookup<Host, Wire> {
  readonly [LOOKUP_HOST]: Host;
  readonly [LOOKUP_WIRE]: Wire;
}
/** Extract the Host object associated with one lookup declaration. */
type TypertLookupHost<Lookup> = Lookup extends TypertLookup<infer Host, infer _Wire> ? Host : never;
/** Extract the wire identity associated with one lookup declaration. */
type TypertLookupWire<Lookup> = Lookup extends TypertLookup<infer _Host, infer Wire> ? Wire : never;
/** Type-level association between a scoped Context kind and its wire identity. */
interface TypertContext<Wire> {
  readonly [CONTEXT_WIRE]: Wire;
}
/** Extract the wire identity associated with one scoped Context declaration. */
type TypertContextWire<ContextType> = ContextType extends TypertContext<infer Wire> ? Wire : never;
/** Merge-extensible Host object lookup declarations. */
interface TypertLookupMap {}
/** Merge-extensible scoped Context declarations. */
interface TypertContextMap {}
/** Awaitable disposer returned by Cordis-owned Typert registrations. */
type TypertDisposer = () => Promise<void>;
type StringKeyOf<Value> = Extract<keyof Value, string>;
/** Minimal runtime-schema capability carried by strict generated codecs. */
interface TypertSchema<Output = unknown> {
  /**
   * Parse and validate one boundary value.
   * @param value - untrusted boundary value.
   * @returns the validated value.
   */
  parse(value: unknown): Output;
}
/** Codec attached to one invocation parameter or result. */
type TypertCodec = {
  readonly mode: 'strict';
  readonly typeSymbol: string;
  readonly schema: TypertSchema;
} | {
  readonly mode: 'src-json';
};
/** One ordered business parameter in a Remote invocation. */
interface InvocationParameterDescriptor {
  /** Source-level parameter name. */
  readonly name: string;
  /** Required key in the wire `args` object. */
  readonly wire: string;
  /** Whether the value is JSON or requires a registered Host lookup. */
  readonly source: 'json' | 'lookup';
  /** Lookup key when `source` is `lookup`. */
  readonly lookup?: string;
  /** Boundary codec for the wire representation. */
  readonly codec: TypertCodec;
  /** Missing wire fields decode to `undefined` only for an explicitly declared `T | undefined`. */
  readonly acceptsUndefined?: true;
}
/** Source position retained for diagnostics from generated definitions. */
interface InvocationSourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}
/** Carrier-independent description of one exported method invocation. */
interface InvocationDescriptor {
  /** Globally stable generated identity. */
  readonly id: string;
  /** Cordis service key owning the method. */
  readonly service: string;
  /** Wire namespace, defaulting to the service key. */
  readonly namespace: string;
  /** Public instance method name. */
  readonly method: string;
  /** Service member invoked when the exported method name is an alias. */
  readonly implementation?: string;
  /** Receiver selection mode. */
  readonly invocation: {
    readonly kind: 'direct';
  } | {
    readonly kind: 'context';
    readonly context: string;
    readonly wire: string;
    readonly codec: TypertCodec;
  };
  /** Optional consuming-Context projection for one direct lookup parameter. */
  readonly scope?: {
    /** Context kind whose Client binder supplies the identity. */
    readonly context: string;
    /** Lookup parameter wire field replaced by the Context identity. */
    readonly wire: string;
  };
  /** Ordered business parameters. */
  readonly parameters: readonly InvocationParameterDescriptor[];
  /** Transport cancellation injected after business parameters instead of entering wire args. */
  readonly cancellation?: {
    /** Reserved final Host method parameter. */
    readonly parameter: 'signal';
  };
  /** Codec for the resolved method result. */
  readonly result: TypertCodec;
  /** Source declaration used only for diagnostics. */
  readonly sourceLocation?: InvocationSourceLocation;
}
/** Generated Host contract selected explicitly by a Client assembly. */
interface TypertRemoteContribution {
  /** npm package that owns the Remote methods. */
  readonly package: string;
  /** Consumer-side invocation descriptors generated from that package. */
  readonly descriptors: readonly InvocationDescriptor[];
}
/**
 * Resolve one validated wire identity, synchronously or asynchronously.
 * @param id - validated wire identity.
 * @returns the Host object, or `undefined` when unavailable.
 */
type TypertLookupResolver<Host = unknown, Wire = unknown> = (id: Wire) => Host | undefined | Promise<Host | undefined>;
/** Runtime provider for one declared Host object lookup. */
interface TypertLookupProvider<Host = unknown, Wire = unknown> {
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string;
  /** Wire field replacing the Host object parameter. */
  readonly wire: string;
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
  /**
   * Resolve a wire identity through the provider's default policy.
   * @param id - validated wire identity.
   * @returns the object, `undefined` when unavailable, or either asynchronously.
   */
  resolve(id: Wire): Host | undefined | Promise<Host | undefined>;
}
/** Stable wire declaration retained after a lookup provider unloads. */
interface TypertLookupDefinition {
  /** Merge-declared lookup key. */
  readonly key: string;
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string;
  /** Wire field replacing the Host object parameter. */
  readonly wire: string;
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
}
/** Host resolver for one scoped Remote kind. */
interface TypertHostContextProvider<Wire = unknown> {
  /** Wire field carrying the Context identity. */
  readonly wire: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
  /**
   * Resolve a wire identity to its live scoped Context.
   * @param id - validated wire identity.
   * @returns the scoped Context, or `undefined` when unavailable.
   */
  resolve(id: Wire): Context | undefined | Promise<Context | undefined>;
}
/** Composition-owned resolver replacing one Host Context provider's default lookup policy. */
type TypertHostContextResolver<Wire = unknown> = (id: Wire) => Context | undefined | Promise<Context | undefined>;
/** Client resolver for the identity carried by the calling scoped Context. */
interface TypertClientContextBinder<Wire = unknown> {
  /**
   * Read the Remote identity represented by a calling Context.
   * @param ctx - Context rebound by the Cordis service tracker.
   * @returns the wire identity, or `undefined` when the Context has the wrong scope.
   */
  identity(ctx: Context): Wire | undefined;
}
/** Notification emitted after a Typert runtime registry changes. */
interface TypertRegistryChange {
  readonly kind: 'local' | 'remote' | 'lookup' | 'host-context' | 'client-context';
  readonly key: string;
}
/** Listener for one Typert runtime registry. */
type TypertRegistryListener = (change: TypertRegistryChange) => void;
/** Current-environment invocation definitions. */
interface TypertLocalRegistry {
  /**
   * Look up one invocation by `<namespace>/<method>`.
   * @param endpoint - canonical endpoint.
   * @returns the live descriptor, or `undefined` when absent.
   */
  get(endpoint: string): InvocationDescriptor | undefined;
  /**
   * Report whether a strict definition has existed during this Typert Service lifetime.
   * @param endpoint - canonical endpoint.
   * @returns `true` after the endpoint has been registered at least once, even if withdrawn.
   */
  hasSeen(endpoint: string): boolean;
  /** @returns a registration-order snapshot of local descriptors. */
  list(): readonly InvocationDescriptor[];
  /**
   * Observe later local-definition changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Consumer-selected Remote contribution registry. */
interface TypertRemoteRegistry {
  /**
   * Register one generated contribution for the calling Cordis fiber.
   * @param contribution - generated Remote descriptors.
   * @returns disposer withdrawing the exact contribution.
   */
  register(contribution: TypertRemoteContribution): TypertDisposer;
  /**
   * Look up one Remote descriptor by endpoint.
   * @param endpoint - canonical endpoint.
   * @returns the descriptor, or `undefined` when unmounted.
   */
  get(endpoint: string): InvocationDescriptor | undefined;
  /** @returns a registration-order snapshot of Remote descriptors. */
  list(): readonly InvocationDescriptor[];
  /**
   * Observe later Remote contribution changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Runtime registry for Host object lookup providers. */
interface TypertLookupRegistry {
  /**
   * Register one provider under its merge-declared key.
   * @param key - lookup key.
   * @param provider - owning package's live resolver.
   * @returns disposer withdrawing the exact provider.
   */
  register<K extends StringKeyOf<TypertLookupMap>>(key: K, provider: TypertLookupProvider<TypertLookupHost<TypertLookupMap[K]>, TypertLookupWire<TypertLookupMap[K]>>): TypertDisposer;
  /**
   * Replace one provider's default resolution policy while this contribution is active.
   * Configuration may precede provider registration; without a live provider, `get()` remains unavailable.
   * @param key - lookup key whose wire declaration remains provider-owned.
   * @param resolver - composition-owned resolver used by every lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configure<K extends StringKeyOf<TypertLookupMap>>(key: K, resolver: TypertLookupResolver<TypertLookupHost<TypertLookupMap[K]>, TypertLookupWire<TypertLookupMap[K]>>): TypertDisposer;
  /**
   * Look up one provider by runtime key.
   * @param key - descriptor lookup key.
   * @returns the live provider, or `undefined` when absent.
   */
  get(key: string): TypertLookupProvider | undefined;
  /** @returns lookup declarations observed during this Typert Service lifetime. */
  definitions(): readonly TypertLookupDefinition[];
  /** @returns a snapshot of registered provider keys. */
  keys(): readonly string[];
  /**
   * Observe later lookup changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Runtime registry for Host Context resolvers and Client Context binders. */
interface TypertContextRegistry {
  /**
   * Register a Host Context resolver.
   * @param key - merge-declared Context key.
   * @param provider - owning package's Host resolver.
   * @returns disposer withdrawing the exact provider.
   */
  registerHost<K extends StringKeyOf<TypertContextMap>>(key: K, provider: TypertHostContextProvider<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Override one Host Context key's identity policy for the calling fiber.
   * Configuration may precede provider registration and restores the provider's default resolver on disposal.
   * @param key - merge-declared Context key.
   * @param resolver - composition-owned resolver used by every Host Context lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configureHost<K extends StringKeyOf<TypertContextMap>>(key: K, resolver: TypertHostContextResolver<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Register a Client Context identity binder.
   * @param key - merge-declared Context key.
   * @param binder - Client scope identity resolver.
   * @returns disposer withdrawing the exact binder.
   */
  registerClient<K extends StringKeyOf<TypertContextMap>>(key: K, binder: TypertClientContextBinder<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Look up a Host Context resolver.
   * @param key - descriptor Context key.
   * @returns the provider, or `undefined` when absent.
   */
  getHost(key: string): TypertHostContextProvider | undefined;
  /**
   * Look up a Client Context binder.
   * @param key - descriptor Context key.
   * @returns the binder, or `undefined` when absent.
   */
  getClient(key: string): TypertClientContextBinder | undefined;
  /**
   * Observe later Context provider changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Minimal Typert runtime consumed through dependency inversion. */
interface TypertRegistryContract {
  readonly local: TypertLocalRegistry;
  readonly remotes: TypertRemoteRegistry;
  readonly lookups: TypertLookupRegistry;
  readonly contexts: TypertContextRegistry;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    typert: TypertRegistryContract;
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.0-rc.6_6fd26f59436a18b115f326d6060415e6/node_modules/@deepseek-ai/dsh-session/lib/types/surface.d.ts
/** Readonly live projection of the message-producing session events. */
interface SessionSurface {
  /** Current surface event sequences in model-visible order. */
  readonly nodes: readonly number[];
  /** Monotonic count of committed positional replacements. */
  readonly replaceGeneration: number;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.0-rc.6_6fd26f59436a18b115f326d6060415e6/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionStore;
  }
  interface Events {
    /**
     * Creation announcement during session publication. A synchronous throw vetoes and rolls
     * back with a paired disposal; detach requested during dispatch is deferred.
     * A returned-promise rejection is logged but cannot retroactively veto this
     * synchronous boundary.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only sessions entered through that agent's context.
     * @param session - the session just entered and announced.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/created'(this: Scoped<Session>, session: Session): void;
    /**
     * Emitted once when an announced session leaves the store, including
     * publication rollback, but never for an entry whose creation announcement
     * did not begin. Listener failures are logged and contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`) reuses the owner scope.
     * @param session - the session that is no longer live in the store.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/disposed'(this: Scoped<Session>, session: Session): void;
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only events from sessions entered through that agent's context.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
    /**
     * Awaited parallel durability checkpoint: every listener runs and the
     * caller awaits all of them, with no waterfall veto. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`) reuses the session's owner scope.
     * @param session - the session whose buffered events must reach durable storage.
     * @dshScopeScan unsupported
     * @mode parallel
     */
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void;
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    session: TypertLookup<Session, SessionId>;
  }
}
/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create live instances via
 * `ctx.sessions.create()` and detached instances via {@link create}.
 * Seeding with an existing event log replays/forks a session.
 * @typert object
 */
declare class Session {
  private log;
  /** Single incremental owner of surface acceptance and projection state. */
  private readonly surfaceManager;
  /** The ordered surface over this session's event log. */
  get surface(): SessionSurface;
  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * seed boundary). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is created without a store-owned header, a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader;
  /** The session identity, derived from its durable header's single copy. */
  get id(): SessionId;
  /**
   * The first seq appended IN THIS PROCESS: the length of the constructor
   * seed (0 without one). Events with smaller seq values entered through
   * construction — replay, fork, or resume — and were never published on the
   * `session/event` firehose (constructor seeds do not emit), so consumers
   * that replay the log as a publication substitute (telemetry adoption)
   * start here. Distinct from `header.seedLength`, the DURABLE fork-lineage
   * boundary: a resumed session's constructor seed is its full stored log,
   * while its header keeps the original fork value — this field is the
   * in-process construction fact.
   *
   * Not persisted itself: a seeded session projects it into the log as the
   * `session/end-seed` event, which is what a consumer reading STORED history
   * reads. Locate the LAST such event, not necessarily one at this seq — a
   * seed already ending in one is not re-marked, so reopening an untouched
   * session leaves that event at a smaller seq than `firstLiveSeq`. Prefer
   * this field in-process: it is exact before the marker reaches storage.
   *
   * When this lifecycle appends the marker, it occupies this seq before the
   * store attaches and therefore does not publish either. Otherwise this seq
   * holds an ordinary published write.
   */
  readonly firstLiveSeq: number;
  /**
   * Create a detached session by validating and snapshotting borrowed seed
   * events and storage metadata.
   * @param id - session identity.
   * @param seed - optional borrowed replay or fork events.
   * @param header - optional borrowed storage metadata.
   * @returns a detached session.
   */
  static create(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader): Session;
  /**
   * Restore a detached session by taking ownership of fresh persistence values.
   * The storage format, event envelopes, sequence continuity, surface transitions,
   * and header fields are validated before the restored objects are frozen.
   * @param id - restored session identity.
   * @param seed - fresh detached events whose ownership is transferred.
   * @param header - fresh detached metadata whose ownership is transferred.
   * @returns a restored detached session.
   */
  static fromRestore(id: SessionId, seed: readonly SessionEvent[], header: SessionHeader): Session;
  private constructor();
  /** Cached immutable public snapshot of the private append-only log. */
  private eventsSnapshot;
  /**
   * An immutable snapshot of the append-only event log. The snapshot is reused
   * until the next append; a previously returned array does not grow later.
   * Events and their nested data are deep-frozen at acceptance, so neither a
   * cast nor ordinary JavaScript can rewrite durable history.
   */
  get events(): readonly SessionEvent[];
  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): number;
  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private publication hooks. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously. Once the event enters
   * the log, the append is committed: observer failures are logged and
   * contained per listener, so they do not change the return value or prevent
   * later listeners from observing the same accepted event.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface metadata: `surfaceOp` controls how the event enters
   *   the ordered surface; `sourceEventSeqs` lists the seq numbers of earlier
   *   events this one derives from. REQUIRED for
   *   {@link SurfaceEventType} events (every message-producing event must
   *   declare how it joins the surface, the sole source of derived model
   *   history) and
   *   rejected by the compiler for non-surface types like `turn/start` or
   *   `assistant/chunk`.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if `data` or surface metadata is not losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance), or when the candidate violates the
   *   canonical surface contract (marker shape and eligibility, unique
   *   earlier source-event references, positional replacement validity, and complete
   *   shadowed-node coverage). One recursive pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush. A synchronous internal dispatch validation failure or an
   *   append reentered while this acceptance/publication boundary is open also
   *   rejects before the log changes.
   */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []): SessionEvent<T>;
  /** Cached fold of the request-header events — see {@link requestHeader}. */
  private headerFold;
  /** Log position (events consumed) the header fold has reached. */
  private headerFoldSeq;
  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.events)`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined;
  /** Cached fold of `request/context` events. */
  private contextFold;
  private contextFoldSeq;
  /**
   * Return the latest resolved route metadata, or `undefined` before the first
   * `request/context` event. Each event is folded once.
   * @returns the latest immutable route metadata.
   */
  requestContext(): RequestContext | undefined;
  /** The derived-message cache: frozen projections, extended per unseen node. */
  private derived;
  /** Surface position (nodes projected) the cache has reached. */
  private derivedNodes;
  /** {@link SurfaceManager.replaceGeneration} the cache was built under. */
  private derivedGeneration;
  /**
   * Derive the LLM message history by walking the ordered sequences of
   * message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, folded per node.
   *
   * CACHED: each surface node is projected exactly once, when first seen — a
   * call costs O(new nodes), and a surface rewrite (a `replace`;
   * {@link SessionSurface.replaceGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**.
   * Their content reuses the already frozen durable event data, so the cache
   * needs no second deep clone and consumers still cannot mutate the log.
   * @returns a fresh array of the shared, frozen derived history.
   */
  deriveMessages(): Message[];
  /**
   * Instance face of the pure per-node `deriveEventMessage` export from
   * `surface.ts`.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null;
}
/** A fork source: either the live session object or its live store id. */
type SessionForkSource = Session | SessionId;
/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
declare class SessionStore extends Service {
  private store;
  private counter;
  constructor(ctx: Context);
  /**
   * Create a session owned by the calling fiber: disposing that fiber stops
   * event notification and removes the session from the store. `options.seed`
   * populates the session with a copy of those events (replay/fork);
   * `options.meta` attaches creation metadata (validated absolute `cwd`, seed
   * and parent lineage, and delegation depth) as the immutable
   * {@link SessionHeader} (the store fills `version`/`id`/`createdAt`).
   *
   * For an agent whose session must be torn down IN ORDER with its loop (so the
   * loop's final events are published before the store attachment ends), do NOT use this
   * — fold the session lifecycle into the agent's own effect via
   * {@link prepare} + {@link enter} + {@link announce} (see
   * `dsh-agent-loop`'s creation transaction).
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the live session, already entered and announced.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session;
  /**
   * Build a session WITHOUT entering it into the store — validate the id/cwd and
   * construct the {@link Session} (with its immutable {@link SessionHeader}).
   * Pairs with {@link enter} + {@link announce}: a caller that owns a composite
   * `ctx.effect` (the agent factory) folds the session lifecycle into that ONE
   * effect so a fiber unload tears the session + agent down as a single ORDERED
   * chain rather than as racing sibling effects — which would remove the publication hooks
   * before the driver's closing events commit, dropping them.
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header. With
   *   `seedSource: 'persistence'`, metadata and events must be fresh detached
   *   graphs whose ownership transfers to this call: they are validated and
   *   frozen in place through {@link Session.fromRestore}, so the caller must
   *   retain no mutable aliases.
   * @returns the constructed session, NOT yet in the store.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path.
   */
  prepare(id?: SessionId, options?: PrepareSessionOptions): Session;
  /**
   * Enter a {@link prepare}d session into the store: install the module-private
   * append publication hooks and add it to the store. Returns the DETACH
   * disposer (hooks + store removal). Does NOT emit `session/created` —
   * the caller yields this disposer inside its effect and THEN calls
   * {@link announce}, so a throwing `session/created` listener rolls the attach
   * back instead of leaking it.
   *
   * Re-checks the id for a duplicate: `prepare` and `enter` are public
   * cross-package primitives and a caller may interleave arbitrary work (or
   * another create) between them, so a stale prepared session must NOT overwrite
   * a live store entry of the same id — its detach disposer would later delete
   * the REAL session. The {@link create} convenience and the agent factory call
   * the two back-to-back so they never trip this, but the public API cannot
   * assume that.
   *
   * @param session - a {@link prepare}d session not yet in the store.
   * @returns the detach disposer (publication hooks + store removal). When called from
   *   a synchronous `session/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   * @throws if a session with this id is already in the store.
   */
  enter(session: Session): () => void;
  /** Remove one exact entered session and emit its paired disposal when announced. */
  private detachEntered;
  /** Emit `session/created` exactly once for an {@link enter}ed session (with
   * the carrier {@link enter} captured). Separate from {@link enter} so the
   * caller can yield the detach disposer first (rollback safety — see
   * {@link enter}).
   * @param session - the entered session to announce to listeners.
   * @throws if the session is not live or its announcement already began,
   *   including a reentrant call from a creation listener. */
  announce(session: Session): void;
  /** Emit the paired teardown notification with per-listener containment. */
  private emitDisposed;
  /**
   * Dispatch the awaited `session/flush` durability checkpoint for `session`,
   * with the carrier captured at {@link enter}. THE flush entry point: the
   * store owns the carrier, so callers (the checkpoint policy's per-request
   * barrier, goal-round-driver's idle checkpoint, teardown drains, and consumers
   * that flush themselves before reading storage) must come through here
   * rather than dispatch a raw `ctx.parallel('session/flush', …)` — one owner,
   * one spelling, and the scoped-dispatch invariant can pin it.
   * @param session - the session whose buffered events must reach durable storage.
   * @returns whether at least one durability listener participated, after every
   *   listener has settled successfully.
   * @throws the first registered listener failure after every listener settles.
   */
  flush(session: Session): Promise<boolean>;
  /** Return the exact live entry; detached/prepared objects reject. */
  private liveEntryFor;
  /**
   * Look up a live session.
   * @param id - the session id to look up.
   * @returns the session, or undefined when no live session has that id.
   */
  get(id: SessionId): Session | undefined;
  /**
   * All live sessions, in creation order.
   * @returns a fresh array; mutating it does not affect the store.
   */
  list(): Session[];
  /**
   * Create a live child session from a stable prefix of a live source.
   * `boundary` is an inclusive source event seq; omitted means the source's
   * current last event. The selected slice may end with a between-turn event
   * but must not end inside an open turn.
   *
   * @param source - Live source session object or id.
   * @param boundary - Inclusive source event seq to fork through; omitted means
   *   the source's current last event, and omitted on an empty source forks an
   *   empty child.
   * @param childSessionId - Optional child session id; omitted delegates to
   *   `SessionStore`'s id policy.
   * @returns The created live child session.
   */
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session;
  private _forkSeed;
  private _resolveForkSource;
}
//#endregion
//#region src/auto-stim/mapper.d.ts
interface EventMapperOptions {
  /** Minimum seconds between two stream ticks (from normalized settings). */
  tickIntervalSec: number;
  /** Injectable clock for tests. */
  now?: () => number;
}
declare class EventMapper {
  private readonly tickMs;
  private readonly now;
  private lastAssistantTurn?;
  private lastTickAt;
  private readonly erroredTurns;
  private prevAgentStatus;
  private lastTodoSignature;
  constructor(options: EventMapperOptions);
  /**
   * Map one persisted session event. Fires for every live session in the
   * host (subagent sessions included) — v0.2 reacts to all of them.
   */
  sessionEvent(event: SessionEvent): AutoStimEvent[];
  /** Map one cordis `agent/error` emit (`turn` numbers share the session space). */
  agentError(turn: number): AutoStimEvent[];
  /** Map one cordis `agent/status` emit; only the running→idle edge fires. */
  agentStatus(status: string): AutoStimEvent[];
}
//#endregion
//#region src/auto-stim/attach.d.ts
declare function attachAutoStim(ctx: Context, mapper: EventMapper, engine: AutoStimEngine, log: (message: string) => void): void;
//#endregion
//#region src/gui/bridge.d.ts
/**
 * One bridge instance serves every connected panel. `broadcast` pushes the
 * same snapshot to all sockets, so two open panels never disagree. When an
 * auto-stim engine is present its status rides along on every snapshot and
 * its change notifications trigger broadcasts too.
 */
declare class GuiBridge {
  private readonly runtime;
  private readonly autoStim?;
  private readonly sockets;
  private unsubscribe;
  private unsubscribeAutoStim;
  private lastImportedCount;
  constructor(runtime: CoyoteRuntime, autoStim?: AutoStimEngine | undefined);
  /** Accept one panel socket; subscribes to runtime/auto-stim changes once globally. */
  handleConnection(socket: WebSocket): void;
  /** Drop every panel connection (plugin teardown). */
  dispose(): void;
  /** Push a fresh snapshot to every connected panel (auto-stim changes use this). */
  broadcast(): void;
  /** RuntimeStatus plus the auto-stim block when the feature is enabled. */
  private composeStatus;
  private dispatch;
  private playRequest;
  /** Push the new snapshot to every panel whenever the runtime or engine changed. */
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
  /** Auto-stim engine whose status rides on coyote_status, when enabled. */
  autoStim?: AutoStimEngine;
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
  /**
   * Event-driven auto-stim (v0.2). Disabled unless `autoStim.enabled` is
   * explicitly true; see README "Auto-stim" for the rule table.
   */
  autoStim?: AutoStimUserConfig;
}
declare const Config: z<Config>;
/** Config after Schemastery defaults; only publicWsUrl and autoStim stay optional. */
type ResolvedConfig = Required<Omit<Config, 'publicWsUrl' | 'autoStim'>> & Pick<Config, 'publicWsUrl' | 'autoStim'>;
/** Validate the resolved values the runtime cannot check itself. @internal */
declare function resolveConfig(config: Config): ResolvedConfig;
/** Register the eight coyote_* tools and mount the GUI bridge (+ auto-stim when enabled). */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { AUTO_STIM_EVENTS, type AutoStimConfig, AutoStimEngine, type AutoStimEvent, type AutoStimRule, type AutoStimSettings, type AutoStimStatus, type AutoStimUserConfig, BUILT_IN_WAVEFORMS, type ComposeSpec, Config, CoyoteError, CoyoteRuntime, type CoyoteRuntimeConfig, CoyoteServer, type CoyoteServerOptions, type CoyoteToolsOptions, DEFAULT_AUTO_STIM_RULES, DEFAULT_AUTO_STIM_SETTINGS, EventMapper, GuiBridge, type PlayWaveRequest, type RuntimeStatus, STRENGTH_MAX, STRENGTH_MIN, type SessionInfo, type StrengthResult, type WaveSource, apply, attachAutoStim, autoStimSchema, composeWave, createCoyoteTools, inject, name, normalizeAutoStimConfig, resolveConfig };