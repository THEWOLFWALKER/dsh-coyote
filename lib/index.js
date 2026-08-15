import z from "@deepseek-ai/schemastery";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import QRCode from "qrcode";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/auto-stim/attach.ts
function attachAutoStim(ctx, mapper, engine, log) {
	const safe = (label, run) => {
		try {
			run();
		} catch (error) {
			log(`auto-stim ${label} handler failed: ${String(error)}`);
		}
	};
	ctx.on("session/event", (_session, event) => safe("session/event", () => {
		for (const domain of mapper.sessionEvent(event)) engine.handle(domain);
	}));
	ctx.on("agent/error", (payload) => safe("agent/error", () => {
		for (const domain of mapper.agentError(payload.turn)) engine.handle(domain);
	}));
	ctx.on("agent/status", (payload) => safe("agent/status", () => {
		const status = payload.status;
		for (const domain of mapper.agentStatus(status)) engine.handle(domain);
	}));
}
//#endregion
//#region src/errors.ts
/** Error type for invalid state, unsafe parameters, or protocol failures. */
var CoyoteError = class extends Error {
	code;
	/**
	* @param message - Actionable operator- or model-facing failure text.
	* @param code - Optional machine-readable tag, e.g. a V3 protocol error code.
	*/
	constructor(message, code) {
		super(message);
		this.code = code;
		this.name = "CoyoteError";
	}
};
/** Maximum waveform period in the input domain (1000 ms = 1 Hz). */
const FREQ_MAX_MS = 1e3;
function clamp$1(value, min, max) {
	return value < min ? min : value > max ? max : value;
}
/**
* Compress a period in ms (10..1000) into the protocol byte domain (10..240).
*
* Official mapping: 10..100 kept, 101..600 -> (x-100)/5+100,
* 601..1000 -> (x-600)/10+200, floored to integers (verified against the
* official conversion table in coyote/extra/README.md).
*/
function compressFrequency(periodMs) {
	if (!Number.isFinite(periodMs)) throw new CoyoteError("frequency period must be a finite number");
	const period = clamp$1(periodMs, 10, FREQ_MAX_MS);
	if (period <= 100) return Math.floor(period);
	if (period <= 600) return Math.floor((period - 100) / 5 + 100);
	return Math.floor((period - 600) / 10 + 200);
}
function byteHex(value) {
	return value.toString(16).padStart(2, "0");
}
function assertWindow(window, index) {
	if (!Number.isFinite(window.freqMs)) throw new CoyoteError(`window ${index}: frequency must be finite`);
	if (window.freqMs < 10 || window.freqMs > 1e3) throw new CoyoteError(`window ${index}: frequency must be within 10..${FREQ_MAX_MS} ms`);
	if (!Number.isFinite(window.intensity)) throw new CoyoteError(`window ${index}: intensity must be finite`);
	if (window.intensity < 0 || window.intensity > 100) throw new CoyoteError(`window ${index}: intensity must be within 0..100`);
}
/** Encode exactly four windows into one 16-hex-character entry. */
function encodeWaveEntry(windows) {
	if (windows.length !== 4) throw new CoyoteError(`a waveform entry needs exactly 4 windows`);
	let hex = "";
	for (let i = 0; i < 4; i += 1) {
		const window = windows[i];
		assertWindow(window, i);
		hex += byteHex(compressFrequency(window.freqMs));
	}
	for (let i = 0; i < 4; i += 1) {
		const window = windows[i];
		hex += byteHex(Math.round(clamp$1(window.intensity, 0, 100)));
	}
	return hex;
}
/** Check whether a string is a syntactically valid 16-hex waveform entry. */
function isWaveEntryHex(value) {
	return /^[0-9a-fA-F]{16}$/.test(value);
}
/** Encode a flat window list (multiple of 4) into protocol entries. */
function encodeWaveSequence(windows) {
	if (windows.length === 0) throw new CoyoteError("waveform sequence needs at least one window");
	if (windows.length % 4 !== 0) throw new CoyoteError(`waveform sequence length must be a multiple of 4`);
	const entries = [];
	for (let i = 0; i < windows.length; i += 4) entries.push(encodeWaveEntry(windows.slice(i, i + 4)));
	return entries;
}
/**
* Scale one entry's intensity bytes (0..100) by a percentage (0..100),
* leaving frequency bytes untouched. 100 is the identity.
*/
function scaleEntryIntensity(entry, percent) {
	if (!isWaveEntryHex(entry)) throw new CoyoteError(`waveform entry must be 16 hex characters: ${entry}`);
	if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new CoyoteError("intensity scale must be within 0..100 percent");
	let out = entry.slice(0, 8);
	for (let i = 8; i < 16; i += 2) {
		const value = Number.parseInt(entry.slice(i, i + 2), 16);
		out += byteHex(Math.round(clamp$1(value * percent / 100, 0, 100)));
	}
	return out;
}
//#endregion
//#region src/waveform/composer.ts
/**
* Parametric waveform synthesizer: turns a small declarative spec into a flat
* window list that the wave codec converts to protocol entries.
*
* Deterministic by default: the `random` curve uses a seeded LCG so the same
* spec always produces the same waveform (reproducible for tests and for the
* agent that wants to "play the same one as last time").
*/
const MAX_DURATION_SEC = 600;
function clamp(value, min, max) {
	return value < min ? min : value > max ? max : value;
}
function assertAxis(axis, min, max, what) {
	for (const [label, value] of [["from", axis.from], ["to", axis.to]]) {
		if (!Number.isFinite(value)) throw new CoyoteError(`${what}.${label} must be finite`);
		if (value < min || value > max) throw new CoyoteError(`${what}.${label} must be within ${min}..${max}`);
	}
}
/** Deterministic small PRNG (mulberry32) so random curves are reproducible. */
function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = state + 1831565813 >>> 0;
		let t = state;
		t = Math.imul(t ^ t >>> 15, t | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
function sampleCurve(curve, from, to, t, random) {
	switch (curve) {
		case "linear": return from + (to - from) * t;
		case "sine": return from + (to - from) * (1 - Math.cos(Math.PI * t)) / 2;
		case "pulse": return t < .5 ? from : to;
		case "random": return from + (to - from) * random();
	}
}
/** Synthesize one waveform from its spec. */
function composeWave(spec, seed = 42) {
	assertAxis(spec.freq, 10, FREQ_MAX_MS, "freq");
	assertAxis(spec.intensity, 0, 100, "intensity");
	if (!Number.isFinite(spec.durationSec) || spec.durationSec <= 0) throw new CoyoteError("durationSec must be a positive number");
	if (spec.durationSec > MAX_DURATION_SEC) throw new CoyoteError(`durationSec cannot exceed ${MAX_DURATION_SEC}`);
	if (spec.dutyCycle !== void 0) {
		const { onSec, offSec } = spec.dutyCycle;
		if (!Number.isFinite(onSec) || onSec <= 0 || !Number.isFinite(offSec) || offSec <= 0) throw new CoyoteError("dutyCycle onSec and offSec must be positive numbers");
	}
	const random = mulberry32(seed);
	const windowCount = Math.round(spec.durationSec * 1e3 / 25);
	const windows = [];
	for (let i = 0; i < windowCount; i += 1) {
		const t = windowCount === 1 ? 0 : i / (windowCount - 1);
		let intensity = sampleCurve(spec.intensity.curve, spec.intensity.from, spec.intensity.to, t, random);
		if (spec.dutyCycle !== void 0) {
			const cycleSec = spec.dutyCycle.onSec + spec.dutyCycle.offSec;
			if (i * 25 / 1e3 % cycleSec >= spec.dutyCycle.onSec) intensity = 0;
		}
		const freq = sampleCurve(spec.freq.curve, spec.freq.from, spec.freq.to, t, random);
		windows.push({
			freqMs: clamp(freq, 10, FREQ_MAX_MS),
			intensity: Math.round(clamp(intensity, 0, 100))
		});
	}
	return {
		windows,
		entryCount: Math.ceil(windowCount / 4)
	};
}
//#endregion
//#region src/waveform/library.ts
const PRESETS = [
	{
		id: "breath",
		name: "Breathing",
		nameZh: "呼吸",
		description: "Slow sine swell, 6s in and out. Gentle continuous baseline.",
		suggestedIntensityPercent: 20,
		spec: {
			freq: {
				from: 300,
				to: 150,
				curve: "sine"
			},
			intensity: {
				from: 10,
				to: 60,
				curve: "sine"
			},
			durationSec: 6
		}
	},
	{
		id: "tide",
		name: "Tide",
		nameZh: "浪潮",
		description: "Rising swell that crashes down and repeats every 8 seconds.",
		suggestedIntensityPercent: 25,
		spec: {
			freq: {
				from: 400,
				to: 100,
				curve: "sine"
			},
			intensity: {
				from: 5,
				to: 90,
				curve: "sine"
			},
			durationSec: 8
		}
	},
	{
		id: "heartbeat",
		name: "Heartbeat",
		nameZh: "心跳",
		description: "Two quick thumps then rest, like a pulse at 60 bpm.",
		suggestedIntensityPercent: 25,
		spec: {
			freq: {
				from: 250,
				to: 250,
				curve: "linear"
			},
			intensity: {
				from: 0,
				to: 80,
				curve: "pulse"
			},
			durationSec: 2,
			dutyCycle: {
				onSec: .3,
				offSec: .7
			}
		}
	},
	{
		id: "tremor",
		name: "Tremor",
		nameZh: "震颤",
		description: "Fast constant buzz for a steady vibrating feel.",
		suggestedIntensityPercent: 20,
		spec: {
			freq: {
				from: 15,
				to: 15,
				curve: "linear"
			},
			intensity: {
				from: 40,
				to: 40,
				curve: "linear"
			},
			durationSec: 5
		}
	},
	{
		id: "tap",
		name: "Tap",
		nameZh: "敲击",
		description: "Discrete taps at 2 Hz with long gaps between them.",
		suggestedIntensityPercent: 30,
		spec: {
			freq: {
				from: 150,
				to: 150,
				curve: "linear"
			},
			intensity: {
				from: 0,
				to: 90,
				curve: "pulse"
			},
			durationSec: 4,
			dutyCycle: {
				onSec: .15,
				offSec: .35
			}
		}
	},
	{
		id: "knead",
		name: "Knead",
		nameZh: "揉捏",
		description: "Medium-frequency squeeze that slowly tightens and releases.",
		suggestedIntensityPercent: 25,
		spec: {
			freq: {
				from: 120,
				to: 60,
				curve: "sine"
			},
			intensity: {
				from: 30,
				to: 80,
				curve: "sine"
			},
			durationSec: 6
		}
	},
	{
		id: "punish",
		name: "Punish",
		nameZh: "惩罚",
		description: "Sharp high-frequency sting with a rising ramp. Intense.",
		suggestedIntensityPercent: 40,
		spec: {
			freq: {
				from: 30,
				to: 12,
				curve: "linear"
			},
			intensity: {
				from: 50,
				to: 100,
				curve: "linear"
			},
			durationSec: 10
		}
	},
	{
		id: "saw",
		name: "Chainsaw",
		nameZh: "电锯",
		description: "Aggressive revving bursts, like a power tool spooling up.",
		suggestedIntensityPercent: 35,
		spec: {
			freq: {
				from: 60,
				to: 10,
				curve: "pulse"
			},
			intensity: {
				from: 30,
				to: 100,
				curve: "linear"
			},
			durationSec: 6,
			dutyCycle: {
				onSec: .4,
				offSec: .2
			}
		}
	},
	{
		id: "scan",
		name: "Wave Scan",
		nameZh: "波扫",
		description: "Frequency sweeps smoothly from slow to fast and back.",
		suggestedIntensityPercent: 25,
		spec: {
			freq: {
				from: 900,
				to: 20,
				curve: "sine"
			},
			intensity: {
				from: 50,
				to: 50,
				curve: "linear"
			},
			durationSec: 10
		}
	},
	{
		id: "random-soft",
		name: "Random Caress",
		nameZh: "随机轻抚",
		description: "Unpredictable gentle fluctuations; never the same twice a second.",
		suggestedIntensityPercent: 20,
		spec: {
			freq: {
				from: 200,
				to: 60,
				curve: "random"
			},
			intensity: {
				from: 15,
				to: 55,
				curve: "random"
			},
			durationSec: 8
		}
	},
	{
		id: "pulse-train",
		name: "Pulse Train",
		nameZh: "脉冲列",
		description: "Metronome-like regular pulses at 1 Hz, machine precision.",
		suggestedIntensityPercent: 30,
		spec: {
			freq: {
				from: 100,
				to: 100,
				curve: "linear"
			},
			intensity: {
				from: 10,
				to: 85,
				curve: "linear"
			},
			durationSec: 5,
			dutyCycle: {
				onSec: .1,
				offSec: .9
			}
		}
	},
	{
		id: "calm",
		name: "Calm Down",
		nameZh: "安抚",
		description: "Decaying fade-out that settles everything back to quiet.",
		suggestedIntensityPercent: 15,
		spec: {
			freq: {
				from: 200,
				to: 500,
				curve: "sine"
			},
			intensity: {
				from: 60,
				to: 0,
				curve: "linear"
			},
			durationSec: 8
		}
	}
];
/** All built-in waveform definitions (specs only, cheap to copy). */
const BUILT_IN_WAVEFORMS = PRESETS;
/** Look up one built-in by id (case-insensitive). */
function getBuiltIn(id) {
	const wanted = id.trim().toLowerCase();
	return PRESETS.find((wave) => wave.id === wanted);
}
/** Synthesize (and cache) the windows of one built-in preset. */
function builtInWindows(id) {
	const wave = getBuiltIn(id);
	if (wave === void 0) return [];
	const runtime = wave;
	runtime.cached ??= composeWave(wave.spec).windows;
	return runtime.cached;
}
//#endregion
//#region src/auto-stim/engine.ts
/** Extra slack after playback before restoring, covering scheduler lag. */
const RESTORE_MARGIN_MS = 500;
var AutoStimEngine = class {
	runtime;
	config;
	log;
	armed = true;
	inFlight = false;
	cooldownUntil = 0;
	fired = 0;
	skipped = 0;
	lastEvent;
	lastSkipReason;
	lastFiredAt;
	restoreTimer;
	restoreResolve;
	/** The pulse currently between boost and restore; set before any device command. */
	activePulse;
	disposed = false;
	listeners = /* @__PURE__ */ new Set();
	constructor(runtime, config, log = () => {}) {
		this.runtime = runtime;
		this.config = config;
		this.log = log;
	}
	/** Entry point from the attach layer; synchronous, never throws. */
	handle(event) {
		if (this.disposed) return;
		const rule = this.config.rules[event];
		if (rule === void 0 || !rule.enabled) return;
		if (!this.armed) return this.skip(event, "disarmed");
		if (this.inFlight) return this.skip(event, "busy");
		const now = Date.now();
		if (now < this.cooldownUntil) return this.skip(event, "cooldown");
		if (this.runtime.status().state !== "bound") return this.skip(event, "not-bound");
		this.inFlight = true;
		this.fired += 1;
		this.lastEvent = event;
		this.lastFiredAt = now;
		this.cooldownUntil = now + this.config.cooldownSec * 1e3;
		this.notify();
		this.fire(rule, event).catch((error) => this.log(`auto-stim ${event} failed: ${String(error)}`)).finally(() => {
			this.inFlight = false;
			this.notify();
		});
	}
	/** GUI arm switch. A pulse already in flight still finishes (including restore). */
	setArmed(armed) {
		if (this.armed === armed) return;
		this.armed = armed;
		this.log(`auto-stim ${armed ? "armed" : "disarmed"}`);
		this.notify();
	}
	/** Coarse change notification for the GUI bridge; returns an unsubscribe. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	status() {
		return {
			enabled: true,
			armed: this.armed,
			maxIntensity: this.config.maxIntensity,
			cooldownSec: this.config.cooldownSec,
			inFlight: this.inFlight,
			fired: this.fired,
			skipped: this.skipped,
			...this.lastEvent === void 0 ? {} : { lastEvent: this.lastEvent },
			...this.lastSkipReason === void 0 ? {} : { lastSkipReason: this.lastSkipReason },
			...this.lastFiredAt === void 0 ? {} : { lastFiredAt: this.lastFiredAt },
			cooldownRemainingSec: Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1e3))
		};
	}
	/**
	* Permanent teardown: cancel the pending restore timer, cut an in-flight
	* pulse short (stopWave makes playWave return early), and restore the
	* pre-pulse strength immediately — teardown must never leave a boosted
	* level behind, whatever phase the pulse was in.
	*/
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.restoreTimer !== void 0) {
			clearTimeout(this.restoreTimer);
			this.restoreTimer = void 0;
		}
		const resolve = this.restoreResolve;
		this.restoreResolve = void 0;
		resolve?.();
		const active = this.activePulse;
		this.activePulse = void 0;
		if (active !== void 0 && this.runtime.status().state === "bound") this.runtime.stopWave().then(() => this.restore(active.selection, active.snapshot)).then(() => this.log(`auto-stim restored to A=${active.snapshot.A} B=${active.snapshot.B}`)).catch((error) => this.log(`auto-stim teardown restore failed: ${String(error)}`));
	}
	async fire(rule, event) {
		const status = this.runtime.status();
		const snapshot = {
			A: status.strength?.a ?? 0,
			B: status.strength?.b ?? 0
		};
		this.activePulse = {
			selection: rule.channel,
			snapshot
		};
		const target = Math.min(rule.intensity, this.config.maxIntensity);
		this.log(`auto-stim ${event}: ${rule.waveform} @ ${target} for ${rule.durationSec}s on ${rule.channel}`);
		const source = this.resolveWaveform(rule.waveform);
		try {
			const boost = await this.runtime.setStrength(rule.channel, { value: target });
			if (boost.applied.A !== target || boost.applied.B !== target) this.log(`auto-stim boost clamped: ${JSON.stringify(boost)}`);
			await this.runtime.playWave({
				source,
				channel: rule.channel,
				mode: "once",
				durationSec: rule.durationSec
			});
		} catch (error) {
			if (this.config.restoreBaseline && !this.disposed) try {
				await this.restore(rule.channel, snapshot);
				this.log(`auto-stim restored to A=${snapshot.A} B=${snapshot.B} after failure`);
			} catch (restoreError) {
				this.log(`auto-stim post-failure restore failed: ${String(restoreError)}`);
			}
			this.activePulse = void 0;
			throw error;
		}
		if (!this.config.restoreBaseline || this.disposed) {
			this.activePulse = void 0;
			return;
		}
		await this.waitRestore(rule.durationSec * 1e3 + RESTORE_MARGIN_MS);
		this.activePulse = void 0;
		if (this.disposed) return;
		try {
			await this.restore(rule.channel, snapshot);
			this.log(`auto-stim restored to A=${snapshot.A} B=${snapshot.B}`);
		} catch (error) {
			this.log(`auto-stim restore failed: ${String(error)}`);
		}
	}
	/**
	* Resolve a rule's waveform name to a play source: built-in id first, then
	* imported waveform name (both case-insensitive). A miss throws, which the
	* handle() catch turns into a log line — a typo'd rule must not crash the
	* host, but it must be visible in the log.
	*/
	resolveWaveform(name) {
		const wanted = name.trim().toLowerCase();
		if (getBuiltIn(wanted) !== void 0) return {
			kind: "builtin",
			id: wanted
		};
		const imported = this.runtime.listWaveforms().find((wave) => wave.source === "imported" && wave.id.toLowerCase() === wanted);
		if (imported !== void 0) return {
			kind: "imported",
			name: imported.name
		};
		throw new CoyoteError(`auto-stim waveform "${name}" is neither built-in nor imported`);
	}
	async restore(selection, snapshot) {
		if (selection === "both") {
			if (snapshot.A === snapshot.B) {
				await this.runtime.setStrength("both", { value: snapshot.A });
				return;
			}
			await this.runtime.setStrength("A", { value: snapshot.A });
			await this.runtime.setStrength("B", { value: snapshot.B });
			return;
		}
		await this.runtime.setStrength(selection, { value: snapshot[selection] });
	}
	waitRestore(ms) {
		return new Promise((resolve) => {
			this.restoreResolve = resolve;
			this.restoreTimer = setTimeout(() => {
				this.restoreTimer = void 0;
				this.restoreResolve = void 0;
				resolve();
			}, ms);
		});
	}
	skip(event, reason) {
		this.skipped += 1;
		this.lastSkipReason = `${event}:${reason}`;
		this.notify();
	}
	notify() {
		for (const listener of [...this.listeners]) try {
			listener();
		} catch (error) {
			this.log(`auto-stim listener failed: ${String(error)}`);
		}
	}
};
//#endregion
//#region src/auto-stim/mapper.ts
/** Upper bound on the per-turn error-dedup set (turns that never closed). */
const MAX_ERROR_TURNS = 512;
var EventMapper = class {
	tickMs;
	now;
	lastAssistantTurn;
	lastTickAt = 0;
	erroredTurns = /* @__PURE__ */ new Set();
	prevAgentStatus;
	lastTodoSignature;
	constructor(options) {
		this.tickMs = Math.max(1, options.tickIntervalSec) * 1e3;
		this.now = options.now ?? (() => Date.now());
	}
	/**
	* Map one persisted session event. Fires for every live session in the
	* host (subagent sessions included) — v0.2 reacts to all of them.
	*/
	sessionEvent(event) {
		switch (event.type) {
			case "turn/start": return ["turn_start"];
			case "assistant/chunk": {
				const { turn } = event.data;
				const now = this.now();
				if (turn !== this.lastAssistantTurn) {
					this.lastAssistantTurn = turn;
					this.lastTickAt = now;
					return ["assistant_start"];
				}
				if (now - this.lastTickAt >= this.tickMs) {
					this.lastTickAt = now;
					return ["stream_tick"];
				}
				return [];
			}
			case "tool/call": return ["tool_call"];
			case "tool/result": return event.data.error !== void 0 ? ["tool_error"] : [];
			case "turn/end": {
				const { turn, reason } = event.data;
				let out = [];
				switch (reason.kind) {
					case "completed":
						out = ["turn_end_completed"];
						break;
					case "error":
						out = this.erroredTurns.has(turn) ? [] : ["agent_error"];
						break;
					case "aborted":
					case "interrupted":
					case "blocked":
						out = ["turn_end_aborted"];
						break;
					case "max-tokens": out = ["turn_end_max_tokens"];
				}
				this.erroredTurns.delete(turn);
				return out;
			}
			case "todo/write": {
				const todos = event.data.todos;
				if (todos.length === 0) return [];
				if (!todos.every((item) => item.status === "completed")) {
					this.lastTodoSignature = void 0;
					return [];
				}
				const signature = JSON.stringify(todos);
				if (signature === this.lastTodoSignature) return [];
				this.lastTodoSignature = signature;
				return ["todo_clear"];
			}
			default: return [];
		}
	}
	/** Map one cordis `agent/error` emit (`turn` numbers share the session space). */
	agentError(turn) {
		if (this.erroredTurns.has(turn)) return [];
		this.erroredTurns.add(turn);
		if (this.erroredTurns.size > MAX_ERROR_TURNS) {
			const oldest = this.erroredTurns.values().next().value;
			if (oldest !== void 0) this.erroredTurns.delete(oldest);
		}
		return ["agent_error"];
	}
	/** Map one cordis `agent/status` emit; only the running→idle edge fires. */
	agentStatus(status) {
		const out = this.prevAgentStatus === "running" && status === "idle" ? ["agent_idle"] : [];
		this.prevAgentStatus = status;
		return out;
	}
};
//#endregion
//#region src/auto-stim/rules.ts
/**
* Auto-stim vocabulary: the eleven domain events, per-event rules, defaults,
* normalization, and the Schemastery schema for deployment config.
*
* Design: the mapper (mapper.ts) reduces DSH host events to this small closed
* vocabulary; the engine (engine.ts) only knows these names. The default
* table below is the single source of truth for docs, schema defaults, and
* tests — every intensity stays at or under the default `maxIntensity` so a
* freshly enabled autoStim never exceeds tickle level out of the box.
*/
/** Every domain event auto-stim can react to. */
const AUTO_STIM_EVENTS = [
	"turn_start",
	"assistant_start",
	"stream_tick",
	"tool_call",
	"tool_error",
	"agent_error",
	"turn_end_completed",
	"turn_end_aborted",
	"turn_end_max_tokens",
	"todo_clear",
	"agent_idle"
];
/** Defaults for the global settings. */
const DEFAULT_AUTO_STIM_SETTINGS = {
	maxIntensity: 30,
	cooldownSec: 5,
	tickIntervalSec: 5,
	restoreBaseline: true
};
/** The default rule table: tickle-level intensities, gentle waves, mostly on. */
const DEFAULT_AUTO_STIM_RULES = {
	turn_start: {
		enabled: true,
		waveform: "tap",
		intensity: 12,
		durationSec: 2,
		channel: "A"
	},
	assistant_start: {
		enabled: true,
		waveform: "tap",
		intensity: 15,
		durationSec: 2,
		channel: "A"
	},
	stream_tick: {
		enabled: false,
		waveform: "tremor",
		intensity: 15,
		durationSec: 2,
		channel: "A"
	},
	tool_call: {
		enabled: true,
		waveform: "tap",
		intensity: 20,
		durationSec: 2,
		channel: "A"
	},
	tool_error: {
		enabled: true,
		waveform: "punish",
		intensity: 25,
		durationSec: 6,
		channel: "A"
	},
	agent_error: {
		enabled: true,
		waveform: "punish",
		intensity: 30,
		durationSec: 8,
		channel: "A"
	},
	turn_end_completed: {
		enabled: true,
		waveform: "heartbeat",
		intensity: 20,
		durationSec: 4,
		channel: "A"
	},
	turn_end_aborted: {
		enabled: false,
		waveform: "calm",
		intensity: 12,
		durationSec: 3,
		channel: "A"
	},
	turn_end_max_tokens: {
		enabled: false,
		waveform: "saw",
		intensity: 20,
		durationSec: 3,
		channel: "A"
	},
	todo_clear: {
		enabled: true,
		waveform: "heartbeat",
		intensity: 18,
		durationSec: 4,
		channel: "A"
	},
	agent_idle: {
		enabled: false,
		waveform: "calm",
		intensity: 12,
		durationSec: 4,
		channel: "A"
	}
};
const CHANNELS$2 = [
	"A",
	"B",
	"both"
];
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function intInRange(value, what, min, max) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new CoyoteError(`dsh-coyote autoStim: ${what} must be an integer from ${min} to ${max}`);
	return value;
}
function positiveNumber(value, what) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new CoyoteError(`dsh-coyote autoStim: ${what} must be a positive number`);
	return value;
}
function nonNegativeNumber(value, what) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new CoyoteError(`dsh-coyote autoStim: ${what} must be a number >= 0`);
	return value;
}
function booleanValue(value, what) {
	if (typeof value !== "boolean") throw new CoyoteError(`dsh-coyote autoStim: ${what} must be a boolean`);
	return value;
}
function normalizeRule(event, raw) {
	const fallback = DEFAULT_AUTO_STIM_RULES[event];
	if (raw === void 0) return { ...fallback };
	if (!isRecord(raw)) throw new CoyoteError(`dsh-coyote autoStim: events.${event} must be an object`);
	return {
		enabled: "enabled" in raw ? booleanValue(raw.enabled, `events.${event}.enabled`) : fallback.enabled,
		waveform: "waveform" in raw && raw.waveform !== void 0 ? (() => {
			if (typeof raw.waveform !== "string" || raw.waveform.trim() === "") throw new CoyoteError(`dsh-coyote autoStim: events.${event}.waveform must be a non-empty string`);
			return raw.waveform.trim();
		})() : fallback.waveform,
		intensity: "intensity" in raw && raw.intensity !== void 0 ? intInRange(raw.intensity, `events.${event}.intensity`, 1, 200) : fallback.intensity,
		durationSec: "durationSec" in raw && raw.durationSec !== void 0 ? positiveNumber(raw.durationSec, `events.${event}.durationSec`) : fallback.durationSec,
		channel: "channel" in raw && raw.channel !== void 0 ? (() => {
			if (typeof raw.channel !== "string" || !CHANNELS$2.includes(raw.channel)) throw new CoyoteError(`dsh-coyote autoStim: events.${event}.channel must be one of A, B, both`);
			return raw.channel;
		})() : fallback.channel
	};
}
/**
* Fill defaults, merge per-field overrides, and validate everything.
* Unknown event names are rejected with the full valid list — a typo like
* `tool_eror` must fail loudly at startup, not silently never fire.
*/
function normalizeAutoStimConfig(raw) {
	const input = raw === void 0 || raw === null ? {} : raw;
	if (!isRecord(input)) throw new CoyoteError("dsh-coyote autoStim: must be an object");
	const settings = {
		maxIntensity: "maxIntensity" in input && input.maxIntensity !== void 0 ? intInRange(input.maxIntensity, "maxIntensity", 1, 200) : DEFAULT_AUTO_STIM_SETTINGS.maxIntensity,
		cooldownSec: "cooldownSec" in input && input.cooldownSec !== void 0 ? nonNegativeNumber(input.cooldownSec, "cooldownSec") : DEFAULT_AUTO_STIM_SETTINGS.cooldownSec,
		tickIntervalSec: "tickIntervalSec" in input && input.tickIntervalSec !== void 0 ? Math.max(1, positiveNumber(input.tickIntervalSec, "tickIntervalSec")) : DEFAULT_AUTO_STIM_SETTINGS.tickIntervalSec,
		restoreBaseline: "restoreBaseline" in input && input.restoreBaseline !== void 0 ? booleanValue(input.restoreBaseline, "restoreBaseline") : DEFAULT_AUTO_STIM_SETTINGS.restoreBaseline
	};
	const events = input.events === void 0 || input.events === null ? {} : input.events;
	if (!isRecord(events)) throw new CoyoteError("dsh-coyote autoStim: events must be an object");
	for (const key of Object.keys(events)) if (!AUTO_STIM_EVENTS.includes(key)) throw new CoyoteError(`dsh-coyote autoStim: unknown event "${key}"; valid events are ${AUTO_STIM_EVENTS.join(", ")}`);
	const rules = {};
	for (const event of AUTO_STIM_EVENTS) rules[event] = normalizeRule(event, events[event]);
	return {
		...settings,
		rules
	};
}
/**
* Schemastery schema for the deployment config. Leaf defaults mirror the
* tables above for host-UI display; `events` stays loose (`z.any()`) because
* normalizeAutoStimConfig is the single validation authority — a strict
* nested schema could silently drop unknown keys (typos) before normalize
* ever sees them.
*/
function autoStimSchema() {
	return z.object({
		enabled: z.boolean().default(false),
		maxIntensity: z.number().default(DEFAULT_AUTO_STIM_SETTINGS.maxIntensity),
		cooldownSec: z.number().default(DEFAULT_AUTO_STIM_SETTINGS.cooldownSec),
		tickIntervalSec: z.number().default(DEFAULT_AUTO_STIM_SETTINGS.tickIntervalSec),
		restoreBaseline: z.boolean().default(DEFAULT_AUTO_STIM_SETTINGS.restoreBaseline),
		events: z.any()
	});
}
//#endregion
//#region src/gui/bridge.ts
const CHANNELS$1 = /* @__PURE__ */ new Set([
	"A",
	"B",
	"both"
]);
/** Import payload cap: a paste larger than this is rejected before parsing. */
const MAX_IMPORT_CHARS = 2e6;
/** Unknown JSON op or malformed frame text. */
var OpError = class extends CoyoteError {};
function asChannel(value) {
	if (typeof value !== "string" || !CHANNELS$1.has(value)) throw new OpError(`channel must be one of A, B, both (got ${JSON.stringify(value)})`);
	return value;
}
function asInt(value, what) {
	if (typeof value !== "number" || !Number.isInteger(value)) throw new OpError(`${what} must be an integer`);
	return value;
}
function asDuration(value, what) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new OpError(`${what} must be a positive number`);
	return value;
}
/**
* One bridge instance serves every connected panel. `broadcast` pushes the
* same snapshot to all sockets, so two open panels never disagree. When an
* auto-stim engine is present its status rides along on every snapshot and
* its change notifications trigger broadcasts too.
*/
var GuiBridge = class {
	runtime;
	autoStim;
	sockets = /* @__PURE__ */ new Set();
	unsubscribe;
	unsubscribeAutoStim;
	lastImportedCount = -1;
	constructor(runtime, autoStim) {
		this.runtime = runtime;
		this.autoStim = autoStim;
	}
	/** Accept one panel socket; subscribes to runtime/auto-stim changes once globally. */
	handleConnection(socket) {
		this.sockets.add(socket);
		if (this.unsubscribe === void 0) this.unsubscribe = this.runtime.subscribe(() => this.onRuntimeChange());
		if (this.unsubscribeAutoStim === void 0 && this.autoStim !== void 0) this.unsubscribeAutoStim = this.autoStim.subscribe(() => this.onRuntimeChange());
		socket.on("message", (raw) => {
			this.dispatch(socket, raw.toString()).catch((error) => {
				this.send(socket, {
					event: "error",
					message: errorMessage(error)
				});
			});
		});
		socket.on("close", () => {
			this.sockets.delete(socket);
			if (this.sockets.size === 0) {
				if (this.unsubscribe !== void 0) {
					this.unsubscribe();
					this.unsubscribe = void 0;
				}
				if (this.unsubscribeAutoStim !== void 0) {
					this.unsubscribeAutoStim();
					this.unsubscribeAutoStim = void 0;
				}
			}
		});
		socket.on("error", () => this.sockets.delete(socket));
		this.send(socket, {
			event: "status",
			status: this.composeStatus()
		});
		this.send(socket, {
			event: "waveforms",
			waveforms: this.runtime.listWaveforms()
		});
	}
	/** Drop every panel connection (plugin teardown). */
	dispose() {
		this.unsubscribe?.();
		this.unsubscribe = void 0;
		this.unsubscribeAutoStim?.();
		this.unsubscribeAutoStim = void 0;
		for (const socket of [...this.sockets]) socket.close(1001, "bridge disposed");
		this.sockets.clear();
	}
	/** Push a fresh snapshot to every connected panel (auto-stim changes use this). */
	broadcast() {
		this.onRuntimeChange();
	}
	/** RuntimeStatus plus the auto-stim block when the feature is enabled. */
	composeStatus() {
		return {
			...this.runtime.status(),
			...this.autoStim === void 0 ? {} : { autoStim: this.autoStim.status() }
		};
	}
	async dispatch(socket, raw) {
		let op;
		try {
			op = JSON.parse(raw);
		} catch {
			throw new OpError("frame is not valid JSON");
		}
		if (typeof op !== "object" || op === null || typeof op.op !== "string") throw new OpError("frame needs an \"op\" string");
		switch (op.op) {
			case "hello":
				this.send(socket, {
					event: "status",
					status: this.composeStatus()
				});
				this.send(socket, {
					event: "waveforms",
					waveforms: this.runtime.listWaveforms()
				});
				return;
			case "pair":
				await this.runtime.pair();
				this.send(socket, {
					event: "ack",
					op: "pair"
				});
				break;
			case "end":
				await this.runtime.endSession();
				this.send(socket, {
					event: "ack",
					op: "end"
				});
				break;
			case "strength":
				await this.runtime.setStrength(asChannel(op.channel), {
					...op.value === void 0 ? {} : { value: asInt(op.value, "value") },
					...op.delta === void 0 ? {} : { delta: asInt(op.delta, "delta") }
				});
				this.send(socket, {
					event: "ack",
					op: "strength"
				});
				break;
			case "play":
				await this.runtime.playWave(this.playRequest(op));
				this.send(socket, {
					event: "ack",
					op: "play"
				});
				break;
			case "stop":
				await this.runtime.stopWave();
				this.send(socket, {
					event: "ack",
					op: "stop"
				});
				break;
			case "panic":
				await this.runtime.panicStop();
				this.send(socket, {
					event: "ack",
					op: "panic"
				});
				break;
			case "auto":
				if (this.autoStim === void 0) throw new OpError("auto-stim is disabled in config (autoStim.enabled)");
				if (typeof op.armed !== "boolean") throw new OpError("auto needs a boolean \"armed\"");
				this.autoStim.setArmed(op.armed);
				this.send(socket, {
					event: "ack",
					op: "auto"
				});
				break;
			case "list":
				this.send(socket, {
					event: "waveforms",
					waveforms: this.runtime.listWaveforms()
				});
				return;
			case "import": {
				const text = op.text;
				if (typeof text !== "string" || text.trim().length === 0) throw new OpError("import needs the file content in \"text\"");
				if (text.length > MAX_IMPORT_CHARS) throw new OpError(`import text exceeds ${MAX_IMPORT_CHARS} characters`);
				const fileName = op.file_name;
				await this.runtime.importWaveform(text, typeof fileName === "string" && fileName.length > 0 ? fileName : "gui-import.pulses");
				this.send(socket, {
					event: "waveforms",
					waveforms: this.runtime.listWaveforms()
				});
				this.send(socket, {
					event: "ack",
					op: "import"
				});
				break;
			}
			default: throw new OpError(`unknown op "${op.op}"`);
		}
		this.send(socket, {
			event: "status",
			status: this.composeStatus()
		});
	}
	playRequest(op) {
		const waveform = typeof op.waveform === "string" ? op.waveform : void 0;
		const hasSpec = op.spec !== void 0;
		if ([
			waveform,
			hasSpec,
			op.hex_entries !== void 0
		].filter(Boolean).length !== 1) throw new OpError("pass exactly one of waveform, spec, or hex_entries");
		let source;
		if (waveform !== void 0) {
			const wanted = waveform.trim().toLowerCase();
			if (getBuiltIn(wanted) !== void 0) source = {
				kind: "builtin",
				id: wanted
			};
			else {
				const imported = this.runtime.listWaveforms().find((wave) => wave.source === "imported" && wave.id.toLowerCase() === wanted);
				if (imported === void 0) throw new OpError(`unknown waveform "${waveform}"`);
				source = {
					kind: "imported",
					name: imported.name
				};
			}
		} else if (hasSpec) source = {
			kind: "spec",
			spec: op.spec
		};
		else {
			const entries = op.hex_entries;
			if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) throw new OpError("hex_entries must be an array of strings");
			source = {
				kind: "hex",
				entries
			};
		}
		const mode = op.mode === void 0 ? "once" : op.mode;
		if (mode !== "once" && mode !== "loop") throw new OpError("mode must be \"once\" or \"loop\"");
		return {
			source,
			channel: op.channel === void 0 ? "A" : asChannel(op.channel),
			mode,
			durationSec: op.duration_sec === void 0 ? 30 : asDuration(op.duration_sec, "duration_sec"),
			...op.intensity_percent === void 0 ? {} : { intensityScalePercent: asInt(op.intensity_percent, "intensity_percent") },
			...op.mirror === void 0 ? {} : { mirrorB: op.mirror === true }
		};
	}
	/** Push the new snapshot to every panel whenever the runtime or engine changed. */
	onRuntimeChange() {
		const status = this.composeStatus();
		for (const socket of [...this.sockets]) this.send(socket, {
			event: "status",
			status
		});
		const importedCount = this.runtime.listWaveforms().length;
		if (importedCount !== this.lastImportedCount) {
			this.lastImportedCount = importedCount;
			const waveforms = this.runtime.listWaveforms();
			for (const socket of [...this.sockets]) this.send(socket, {
				event: "waveforms",
				waveforms
			});
		}
	}
	send(socket, event) {
		if (socket.readyState !== socket.OPEN) return;
		socket.send(JSON.stringify(event), (error) => {
			if (error != null) this.sockets.delete(socket);
		});
	}
};
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/protocol/frames.ts
/**
* Pure V3 socket protocol: frame parse/encode and command message builders.
*
* Frame shape and every command string below follow the official
* DG-LAB-OPENSOURCE socket protocol (ZGQ-inc/DG-LAB-OPENSOURCE, socket/README.md):
* - Frame: {"type","clientId","targetId","message"} JSON, max 1950 chars.
* - Strength command: strength-{1|2}+{0|1|2}+{0..200} (numeric channel).
* - Strength report: strength-A+B+limitA+limitB (letter channel).
* - Pulse command: pulse-{A|B}:["hex",...] (letter channel, JSON array, max 100 entries).
* - Clear queue: clear-{1|2} (numeric channel).
* - Feedback: feedback-{0..9}.
*/
/** Maximum JSON frame length accepted by the App before it drops the message. */
const MAX_FRAME_LENGTH = 1950;
/** Official V3 error codes mapped to their documented meanings. */
const ERROR_CODES = {
	OK: "200",
	PEER_DISCONNECTED: "209",
	QR_NO_CLIENT_ID: "210",
	BIND_TIMEOUT: "211",
	ALREADY_BOUND: "400",
	TARGET_NOT_FOUND: "401",
	NOT_BOUND: "402",
	INVALID_JSON: "403",
	OFFLINE: "404",
	MESSAGE_TOO_LONG: "405",
	INTERNAL: "500"
};
const FRAME_TYPES = [
	"bind",
	"heartbeat",
	"msg",
	"break",
	"error"
];
/** Parse one raw JSON frame; throws CoyoteError('403') on non-frame input. */
function parseFrame(raw) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new CoyoteError("frame is not valid JSON", ERROR_CODES.INVALID_JSON);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CoyoteError("frame is not a JSON object", ERROR_CODES.INVALID_JSON);
	const { type, clientId, targetId, message } = value;
	if (typeof type !== "string" || !FRAME_TYPES.includes(type)) throw new CoyoteError("frame type must be bind|heartbeat|msg|break|error", ERROR_CODES.INVALID_JSON);
	if (typeof clientId !== "string" || typeof targetId !== "string" || typeof message !== "string") throw new CoyoteError("frame must carry string clientId/targetId/message", ERROR_CODES.INVALID_JSON);
	return {
		type,
		clientId,
		targetId,
		message
	};
}
/** Encode one frame to its JSON wire form; throws when it exceeds 1950 chars. */
function encodeFrame(frame) {
	const json = JSON.stringify({
		type: frame.type,
		clientId: frame.clientId,
		targetId: frame.targetId,
		message: frame.message
	});
	if (json.length > 1950) throw new CoyoteError(`encoded frame exceeds ${MAX_FRAME_LENGTH} characters (${json.length})`, ERROR_CODES.MESSAGE_TOO_LONG);
	return json;
}
const STRENGTH_DOMAIN_MAX = 200;
function assertStrengthValue(value, what) {
	if (!Number.isInteger(value) || value < 0 || value > STRENGTH_DOMAIN_MAX) throw new CoyoteError(`${what} must be an integer from 0 to ${STRENGTH_DOMAIN_MAX}`);
}
/** Map a letter channel to the numeric channel used by strength and clear commands. */
function channelNumber(channel) {
	return channel === "A" ? 1 : 2;
}
/** Build a strength command message: strength-{1|2}+{0|1|2}+{0..200}. */
function strengthCommand(channel, action, value) {
	assertStrengthValue(value, "strength value");
	return `strength-${channelNumber(channel)}+${action}+${value}`;
}
/** Parse an App strength report `strength-A+B+limitA+limitB` in the 0-200 domain. */
function parseStrengthReport(message) {
	const parts = message.split("+");
	if (parts.length !== 4 || !parts[0].startsWith("strength-")) throw new CoyoteError(`malformed strength report: ${message}`);
	const values = [Number.parseInt(parts[0].slice(9), 10), ...parts.slice(1).map((part) => Number.parseInt(part, 10))];
	for (const value of values) if (!Number.isInteger(value) || value < 0 || value > STRENGTH_DOMAIN_MAX) throw new CoyoteError(`strength report value out of range: ${message}`);
	const [a, b, limitA, limitB] = values;
	return {
		a,
		b,
		limitA,
		limitB
	};
}
/** Build a pulse message: pulse-{A|B}:["hex",...] with the official 100-entry cap. */
function pulseMessage(channel, entries) {
	if (entries.length === 0) throw new CoyoteError("pulse message requires at least one entry");
	if (entries.length > 100) throw new CoyoteError(`pulse message exceeds 100 entries`, ERROR_CODES.MESSAGE_TOO_LONG);
	return `pulse-${channel}:${JSON.stringify(entries)}`;
}
/** Build a queue-clear message: clear-{1|2} (numeric channel per protocol). */
function clearMessage(channel) {
	return `clear-${channelNumber(channel)}`;
}
/** Recognize an App feedback message `feedback-{0..9}`; returns undefined otherwise. */
function parseFeedback(message) {
	if (!message.startsWith("feedback-")) return void 0;
	const index = Number.parseInt(message.slice(9), 10);
	if (!Number.isInteger(index) || index < 0 || index > 9) return void 0;
	return {
		index,
		channel: index < 5 ? "A" : "B"
	};
}
/** Frame the server sends to acknowledge a successful bind (code 200). */
function bindOkFrame(controlId, appClientId) {
	return {
		type: "bind",
		clientId: controlId,
		targetId: appClientId,
		message: ERROR_CODES.OK
	};
}
/** Frame either side sends as a heartbeat ping (official backend uses "200"). */
function heartbeatFrame(clientId, targetId) {
	return {
		type: "heartbeat",
		clientId,
		targetId,
		message: ERROR_CODES.OK
	};
}
/** Frame the server sends when it drops the connection. */
function breakFrame(controlId, appClientId, code) {
	return {
		type: "break",
		clientId: controlId,
		targetId: appClientId,
		message: code
	};
}
//#endregion
//#region src/protocol/qr.ts
/**
* QR payload assembly for App pairing.
*
* The App only accepts QR content of the exact shape
* `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#{wsUrl}/{controlId}`
* with exactly two `#` separators and nothing between the WebSocket URL and
* the control id. Source: DG-LAB-OPENSOURCE socket/README.md, 终端二维码.
*/
/** Official App download URL prefix required by the QR format. */
const QR_PREFIX = "https://www.dungeon-lab.com/app-download.php";
/** Protocol tag required by the QR format. */
const QR_TAG = "DGLAB-SOCKET";
/** Build the QR payload the App scans to reach this server. */
function buildQrPayload(wsUrl, controlId) {
	const ws = wsUrl.trim();
	if (ws.length === 0) throw new CoyoteError("wsUrl cannot be empty");
	if (!ws.startsWith("ws://") && !ws.startsWith("wss://")) throw new CoyoteError("wsUrl must start with ws:// or wss://");
	if (ws.includes("#")) throw new CoyoteError("wsUrl cannot contain #");
	const id = controlId.trim();
	if (id.length === 0) throw new CoyoteError("controlId cannot be empty");
	if (id.includes("#") || id.includes("/")) throw new CoyoteError("controlId cannot contain # or /");
	return `${QR_PREFIX}#${QR_TAG}#${ws}/${id}`;
}
//#endregion
//#region src/transport/server.ts
/**
* DG-LAB V3 socket transport: the WebSocket endpoint the official App
* connects to, merged with the third-party control terminal role.
*
* Binding flow (DG-LAB-OPENSOURCE socket/README.md, 关系绑定):
* 1. `beginSession` mints a 32-hex controlId and a QR payload
*    `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://…/{controlId}`.
* 2. The App scans the QR and connects to `ws://…/{controlId}`.
* 3. We assign the App its own id and answer with the initial bind frame
*    `{"type":"bind","clientId":appClientId,"targetId":"","message":appClientId}`
*    (the demo frontend reads clientId when targetId is empty; the README
*    wording also allows reading message — both carry the id).
* 4. The App answers `{"type":"bind","clientId":controlId,"targetId":appClientId,"message":"DGLAB"}`.
* 5. We confirm with the bind-ok frame (`message:"200"`); the relation is live.
*
* Heartbeat frames mirror the official demo backend: one per interval,
* message "200", clientId set to the recipient's own id.
*/
const DEFAULTS$2 = {
	host: "0.0.0.0",
	port: 0,
	bindTimeoutMs: 15e3,
	heartbeatIntervalMs: 6e4,
	qrWidth: 240
};
/** Pick the first non-internal IPv4 address for the default QR URL. */
function detectLanAddress() {
	for (const list of Object.values(networkInterfaces())) for (const net of list ?? []) if (net.family === "IPv4" && !net.internal) return net.address;
	return "127.0.0.1";
}
function newId() {
	return randomUUID().replace(/-/g, "");
}
/**
* The merged socket server + control terminal. Implements `WaveTransport`
* so the scheduler can drive it directly.
*/
var CoyoteServer = class {
	options;
	handlers;
	wss;
	session;
	disposed = false;
	guiHandler;
	guiSockets = /* @__PURE__ */ new Set();
	/** Latest device-reported strengths while bound. */
	strength;
	constructor(options = {}, handlers = {}) {
		this.options = options;
		this.handlers = handlers;
	}
	/** Current connection lifecycle state. */
	get state() {
		if (this.session === void 0) return "idle";
		return this.session.app?.bound === true ? "bound" : "waiting-app";
	}
	/** Whether the App completed binding and the socket is open. */
	isBound() {
		const app = this.session?.app;
		return app !== void 0 && app.bound && app.socket.readyState === WebSocket.OPEN;
	}
	/** Our control id for the active session, when one exists. */
	get controlId() {
		return this.session?.controlId;
	}
	/**
	* Route `/gui` connections to the browser-panel bridge. Call once before
	* `start()`; the server tracks GUI sockets so teardown can close them.
	*/
	setGuiHandler(handler) {
		this.guiHandler = handler;
	}
	/** Start listening. Safe to call once; resolves with the bound address. */
	async start() {
		if (this.wss !== void 0) throw new CoyoteError("coyote server already started");
		if (this.disposed) throw new CoyoteError("coyote server was disposed");
		const wss = new WebSocketServer({
			host: this.options.host ?? DEFAULTS$2.host,
			port: this.options.port ?? DEFAULTS$2.port
		});
		await new Promise((resolve, reject) => {
			wss.once("listening", () => resolve());
			wss.once("error", reject);
		});
		this.wss = wss;
		wss.on("connection", (socket, request) => {
			this.handleConnection(socket, request.url ?? "/").catch((error) => {
				this.log(`connection handler failed: ${String(error)}`);
				socket.close(1011, "server error");
			});
		});
		const address = wss.address();
		const port = typeof address === "object" && address !== null ? address.port : this.options.port ?? 0;
		this.log(`listening on ${this.options.host ?? DEFAULTS$2.host}:${port}`);
		return {
			host: this.options.host ?? DEFAULTS$2.host,
			port
		};
	}
	/**
	* Mint a pairing session (control id + QR). Idempotent while unbound:
	* calling again before the App binds returns the same session.
	*/
	async beginSession() {
		if (this.disposed) throw new CoyoteError("coyote server was disposed");
		if (this.session?.app?.bound === true) throw new CoyoteError("an App is already bound; end the session first", ERROR_CODES.ALREADY_BOUND);
		if (this.session !== void 0) return {
			controlId: this.session.controlId,
			qrPayload: this.session.qrPayload,
			qrDataUrl: this.session.qrDataUrl
		};
		if (this.wss === void 0) throw new CoyoteError("coyote server not started");
		const controlId = newId();
		const address = this.wss.address();
		if (typeof address !== "object" || address === null) throw new CoyoteError("coyote server has no address");
		const host = address.address === "::" || address.address === "0.0.0.0" ? detectLanAddress() : address.address;
		const base = this.options.publicWsUrl?.replace(/\/+$/, "") ?? `ws://${host}:${address.port}`;
		const qrPayload = buildQrPayload(base, controlId);
		const qrDataUrl = await QRCode.toDataURL(qrPayload, {
			margin: 1,
			width: this.options.qrWidth ?? DEFAULTS$2.qrWidth
		});
		this.session = {
			controlId,
			qrPayload,
			qrDataUrl
		};
		this.log(`session ${controlId} waiting for App at ${base}/${controlId}`);
		return {
			controlId,
			qrPayload,
			qrDataUrl
		};
	}
	/** Send one strength command to the bound App. */
	async sendStrength(channel, action, value) {
		await this.sendCommand(strengthCommand(channel, action, value));
	}
	/** WaveTransport: one pulse segment (already capped at 100 by the caller). */
	async sendPulse(channel, entries) {
		await this.sendCommand(pulseMessage(channel, entries));
	}
	/** WaveTransport: clear one channel's pending waveform queue. */
	async clearPulse(channel) {
		await this.sendCommand(clearMessage(channel));
	}
	/**
	* End the active session: notify a bound App with a break frame (209),
	* close the socket, and drop the QR. A fresh `beginSession` mints new ids.
	*/
	async endSession() {
		const app = this.session?.app;
		if (app !== void 0) {
			if (app.bound && app.socket.readyState === WebSocket.OPEN) await this.write(app, breakFrame(this.session.controlId, app.appClientId, ERROR_CODES.PEER_DISCONNECTED));
			await this.closeSocket(app);
		}
		this.session = void 0;
		this.strength = void 0;
	}
	/** Permanent teardown: end the session, drop GUI panels, stop listening. */
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		await this.endSession();
		for (const socket of [...this.guiSockets]) {
			socket.close(1001, "server teardown");
			this.guiSockets.delete(socket);
		}
		const wss = this.wss;
		if (wss !== void 0) {
			await new Promise((resolve) => {
				wss.close(() => resolve());
			});
			this.wss = void 0;
		}
	}
	async handleConnection(socket, url) {
		const path = url.split("?")[0] ?? url;
		if (path === "/gui" || path === "/gui/") {
			if (this.guiHandler === void 0) {
				this.log("rejected GUI connection: no bridge mounted");
				socket.close(1008, "gui bridge not enabled");
				return;
			}
			this.guiSockets.add(socket);
			socket.on("close", () => this.guiSockets.delete(socket));
			this.guiHandler(socket);
			return;
		}
		const session = this.session;
		if (session === void 0 || session.app?.bound === true || session.app !== void 0) {
			this.log(`rejected extra connection ${url}`);
			socket.close(1008, "no pairing session");
			return;
		}
		const expected = `/${session.controlId}`;
		if (url !== expected && url !== `${expected}/`) {
			this.log(`rejected connection ${url}: path does not match the pairing id`);
			socket.close(1008, "unknown pairing id");
			return;
		}
		const appClientId = newId();
		const app = {
			socket,
			appClientId,
			bound: false
		};
		session.app = app;
		this.log(`App socket connected as ${appClientId}`);
		socket.on("message", (data) => this.handleMessage(app, data.toString()));
		socket.on("close", () => this.handleClose(app, "app closed the connection"));
		socket.on("error", (error) => {
			this.log(`App socket error: ${String(error)}`);
			this.handleClose(app, "socket error");
		});
		app.bindTimer = setTimeout(() => {
			if (!app.bound) {
				this.log("App socket never completed the DGLAB bind handshake");
				socket.close(4e3, "bind timeout");
			}
		}, this.options.bindTimeoutMs ?? DEFAULTS$2.bindTimeoutMs);
		await this.write(app, {
			type: "bind",
			clientId: appClientId,
			targetId: "",
			message: appClientId
		});
	}
	handleMessage(app, raw) {
		let frame;
		try {
			frame = parseFrame(raw);
		} catch (error) {
			this.log(`dropping malformed frame: ${String(error)}`);
			this.safeWrite(app, {
				type: "error",
				clientId: "",
				targetId: app.appClientId,
				message: ERROR_CODES.INVALID_JSON
			});
			return;
		}
		if (frame.type === "bind") {
			this.handleBind(app, frame);
			return;
		}
		if (frame.type === "heartbeat") return;
		if (frame.type === "break") {
			this.closeSocket(app);
			return;
		}
		if (frame.type === "error") {
			this.log(`App reported error ${frame.message}`);
			return;
		}
		if (!app.bound) {
			this.log(`ignoring ${frame.type} frame before bind`);
			return;
		}
		if (frame.message.startsWith("strength-")) {
			try {
				const strength = parseStrengthReport(frame.message);
				this.strength = strength;
				this.handlers.onStrength?.(strength);
			} catch (error) {
				this.log(`dropping strength report: ${String(error)}`);
			}
			return;
		}
		const feedback = parseFeedback(frame.message);
		if (feedback !== void 0) {
			this.handlers.onFeedback?.(feedback);
			return;
		}
		this.log(`ignoring App message ${frame.message.slice(0, 60)}`);
	}
	handleBind(app, frame) {
		const session = this.session;
		if (session === void 0 || session.app !== app) return;
		if (frame.message !== "DGLAB") {
			this.log(`ignoring bind message ${frame.message}`);
			return;
		}
		if (frame.clientId !== session.controlId || frame.targetId !== app.appClientId) {
			this.log(`bind ids mismatch: clientId=${frame.clientId} targetId=${frame.targetId}`);
			this.safeWrite(app, {
				type: "error",
				clientId: "",
				targetId: app.appClientId,
				message: ERROR_CODES.NOT_BOUND
			});
			return;
		}
		app.bound = true;
		if (app.bindTimer !== void 0) clearTimeout(app.bindTimer);
		const interval = this.options.heartbeatIntervalMs ?? DEFAULTS$2.heartbeatIntervalMs;
		app.heartbeatTimer = setInterval(() => {
			this.safeWrite(app, heartbeatFrame(app.appClientId, session.controlId)).catch(() => {});
		}, interval);
		this.safeWrite(app, bindOkFrame(session.controlId, app.appClientId));
		this.log(`App ${app.appClientId} bound`);
		this.handlers.onBound?.();
	}
	handleClose(app, reason) {
		const session = this.session;
		if (session?.app !== app) return;
		if (app.bindTimer !== void 0) clearTimeout(app.bindTimer);
		if (app.heartbeatTimer !== void 0) clearInterval(app.heartbeatTimer);
		session.app = void 0;
		if (app.bound) {
			this.session = void 0;
			this.strength = void 0;
			this.log(`bound session ended: ${reason}`);
			this.handlers.onDisconnect?.(reason);
		} else this.log(`unbound App socket closed: ${reason}`);
	}
	async sendCommand(message) {
		const session = this.session;
		const app = session?.app;
		if (session === void 0 || app === void 0 || !app.bound) throw new CoyoteError("no bound App session", ERROR_CODES.NOT_BOUND);
		await this.write(app, {
			type: "msg",
			clientId: session.controlId,
			targetId: app.appClientId,
			message
		});
	}
	/** Write one frame; a send failure ends the session (fail-safe). */
	async write(app, frame) {
		if (app.socket.readyState !== WebSocket.OPEN) throw new CoyoteError("App socket is not open", ERROR_CODES.OFFLINE);
		const json = encodeFrame(frame);
		await new Promise((resolve, reject) => {
			app.socket.send(json, (error) => error == null ? resolve() : reject(error));
		}).catch((error) => {
			this.closeSocket(app);
			throw error;
		});
	}
	async safeWrite(app, frame) {
		try {
			await this.write(app, frame);
		} catch (error) {
			this.log(`write failed: ${String(error)}`);
		}
	}
	async closeSocket(app) {
		if (app.socket.readyState === WebSocket.OPEN || app.socket.readyState === WebSocket.CONNECTING) await new Promise((resolve) => {
			app.socket.once("close", resolve);
			app.socket.close(1e3, "dsh-coyote session end");
			setTimeout(resolve, 250).unref?.();
		});
		this.handleClose(app, "closed by server");
	}
	log(message) {
		this.handlers.onLog?.(message);
	}
};
//#endregion
//#region src/waveform/importer.ts
/**
* Community waveform import: DG-Lab-Coyote-Game-Hub `.pulses` JSON, plain
* Game-Hub-style object arrays, and bare hex lists.
*
* Format reference (openclaw-plugin-dg-lab ships the same three shapes):
* - Game-Hub JSON: `[{"id":..,"name":"..","pulseData":["16hex",..]},..]`
* - Bare hex: one waveform per file, entries separated by newlines/commas.
*/
function normalizeEntries(raw) {
	const entries = raw.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
	for (const entry of entries) if (!isWaveEntryHex(entry)) throw new CoyoteError(`invalid waveform entry (need 16 hex characters): ${entry}`);
	if (entries.length === 0) throw new CoyoteError("waveform has no entries");
	return entries;
}
/** Parse Game-Hub `.pulses` / JSON array text into imported waveforms. */
function parseGameHubJson(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new CoyoteError("Game-Hub waveform file is not valid JSON");
	}
	if (!Array.isArray(value)) throw new CoyoteError("Game-Hub waveform file must be a JSON array");
	const waves = [];
	value.forEach((record, index) => {
		if (typeof record !== "object" || record === null || Array.isArray(record)) throw new CoyoteError(`Game-Hub entry ${index} is not an object`);
		const { id, name, pulseData } = record;
		if (!Array.isArray(pulseData) || pulseData.some((entry) => typeof entry !== "string")) throw new CoyoteError(`Game-Hub entry ${index} has no string[] pulseData`);
		const label = typeof name === "string" && name.trim().length > 0 ? name.trim() : typeof id === "string" || typeof id === "number" ? String(id) : `wave-${index + 1}`;
		waves.push({
			name: label,
			entries: normalizeEntries(pulseData)
		});
	});
	if (waves.length === 0) throw new CoyoteError("Game-Hub waveform file contains no waveforms");
	return waves;
}
/** Parse a bare hex list (newline or comma separated) into one waveform. */
function parseHexList(text, name) {
	return {
		name,
		entries: normalizeEntries(text.split(/[\n,]+/))
	};
}
/** Parse one file by shape: JSON array means Game-Hub, otherwise bare hex. */
function parseWaveformFile(text, fileName) {
	if (text.trim().startsWith("[")) return parseGameHubJson(text).map((wave) => ({
		...wave,
		source: fileName
	}));
	return [{
		...parseHexList(text, basename(fileName).replace(/\.[^.]+$/, "")),
		source: fileName
	}];
}
/** Load every importable file under a directory (non-recursive, best effort). */
async function loadWaveformDir(dir) {
	let files;
	try {
		files = await readdir(dir);
	} catch {
		return [];
	}
	const waves = [];
	for (const file of files) {
		if (!/\.(json|pulses|txt)$/i.test(file)) continue;
		try {
			const text = await readFile(join(dir, file), "utf8");
			waves.push(...parseWaveformFile(text, file));
		} catch {}
	}
	return waves;
}
//#endregion
//#region src/waveform/scheduler.ts
const DEFAULTS$1 = {
	segmentSize: 70,
	leadMs: 200,
	clearGapMs: 150,
	minIntervalMs: 50
};
/** Invert the intensity axis of one hex entry (bytes 4-7). */
function mirrorEntry(entry) {
	const bytes = [];
	for (let i = 0; i < 16; i += 2) if (i >= 8) {
		const value = Number.parseInt(entry.slice(i, i + 2), 16);
		bytes.push(Math.max(0, Math.min(100, 100 - value)).toString(16).padStart(2, "0"));
	} else bytes.push(entry.slice(i, i + 2));
	return bytes.join("");
}
/** Segment a play through the transport with looping and hard duration caps. */
var WaveScheduler = class {
	transport;
	options;
	reportFailure;
	onIdle;
	runs = /* @__PURE__ */ new Map();
	disposing = false;
	constructor(transport, options = {}, reportFailure = () => {}, onIdle = () => {}) {
		this.transport = transport;
		this.options = options;
		this.reportFailure = reportFailure;
		this.onIdle = onIdle;
	}
	/** Start one playback, replacing whatever ran on the target channels. */
	async play(request) {
		if (this.disposing) throw new Error("waveform scheduler is shutting down");
		if (request.entries.length === 0) throw new Error("playback needs at least one entry");
		if (!(request.durationSec > 0)) throw new Error("durationSec must be positive");
		const channels = request.channel === "both" ? ["A", "B"] : [request.channel];
		for (const channel of channels) {
			this.cancelChannel(channel);
			await this.transport.clearPulse(channel);
		}
		await delay(this.resolved().clearGapMs);
		const token = Symbol("coyote-play");
		for (const channel of channels) {
			const run = {
				token,
				timers: /* @__PURE__ */ new Set()
			};
			this.runs.set(channel, run);
			const entries = channel === "B" && request.mirrorB === true ? request.entries.map(mirrorEntry) : request.entries;
			this.scheduleChannel(channel, run, entries, request.mode, request.durationSec * 1e3);
		}
		return {
			channels,
			mode: request.mode,
			durationSec: request.durationSec,
			segments: Math.ceil(request.entries.length / this.resolved().segmentSize)
		};
	}
	/** Stop every channel: cancel timers, clear queues. */
	async stopAll() {
		for (const channel of ["A", "B"]) this.cancelChannel(channel);
		try {
			await this.transport.clearPulse("A");
			await this.transport.clearPulse("B");
		} catch (error) {
			this.reportFailure(error);
		}
	}
	/** Whether any channel has an active run. */
	isPlaying() {
		return this.runs.size > 0;
	}
	/** Reject new plays, stop everything. Used on plugin teardown. */
	async dispose() {
		this.disposing = true;
		await this.stopAll();
	}
	scheduleChannel(channel, run, entries, mode, durationMs) {
		const { segmentSize, leadMs, minIntervalMs } = this.resolved();
		const segments = [];
		for (let i = 0; i < entries.length; i += segmentSize) segments.push(entries.slice(i, i + segmentSize));
		const startedAt = Date.now();
		/**
		* End this channel's run. Also drops whatever still sits in the device's
		* waveform queue (it may hold up to one segment, ~7s): a duration cap
		* or a replaced playback must stop output at once, not drain the tail.
		*/
		const finish = () => {
			if (this.runs.get(channel)?.token === run.token) this.runs.delete(channel);
			this.transport.clearPulse(channel).catch(() => {});
			if (this.runs.size === 0) this.onIdle();
		};
		const sendSegment = (index) => {
			if (this.runs.get(channel)?.token !== run.token) return;
			if (Date.now() - startedAt >= durationMs) {
				finish();
				return;
			}
			const segment = segments[index];
			this.transport.sendPulse(channel, segment).catch((error) => {
				this.reportFailure(error);
				finish();
			});
			const next = mode === "loop" ? (index + 1) % segments.length : index + 1;
			if (mode === "once" && next >= segments.length) {
				const elapsedBudget = durationMs - (Date.now() - startedAt);
				const endTimer = setTimeout(() => finish(), Math.max(minIntervalMs, elapsedBudget));
				run.timers.add(endTimer);
				return;
			}
			const segmentMs = segment.length * 100;
			const interval = Math.max(minIntervalMs, segmentMs - leadMs);
			const timer = setTimeout(() => sendSegment(next), interval);
			run.timers.add(timer);
		};
		sendSegment(0);
	}
	cancelChannel(channel) {
		const run = this.runs.get(channel);
		if (run === void 0) return;
		for (const timer of run.timers) clearTimeout(timer);
		this.runs.delete(channel);
	}
	resolved() {
		return {
			...DEFAULTS$1,
			...this.options
		};
	}
};
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region src/runtime/runtime.ts
/**
* Runtime safety envelope around the transport and the waveform scheduler.
*
* Every destructive path is bounded, asymmetric, and fail-safe:
* - Soft limits: per-channel agent-side caps in the 0..200 strength domain;
*   the effective cap is min(soft limit, App-reported device limit).
* - Asymmetric rate limiting: strength increases draw from a refilling token
*   bucket (burst + rate), decreases are always immediate.
* - Fail-safe: an App disconnect stops playback and clears both queues.
* - Session cooldown: a fresh pairing cannot start until the cooldown after
*   the previous session elapsed (adjustable, 0 disables).
* - Session and playback duration caps with a hard timer.
*
* The App-side hard limit always wins physically: the user can lower it at
* any time on the phone, and every clamp decision re-reads the latest report.
*/
/** Strength domain bounds (0..200 per the socket protocol). */
const STRENGTH_MIN = 0;
const STRENGTH_MAX = 200;
const DEFAULTS = {
	softLimit: 100,
	sessionCooldownSec: 3,
	maxSessionSec: 3600,
	maxPlaySec: 600,
	increaseRatePerSec: 40,
	increaseBurst: 40
};
function assertLimit(value, what) {
	if (!Number.isInteger(value) || value < 0 || value > 200) throw new CoyoteError(`${what} must be an integer from 0 to 200`);
}
function assertNonNegative(value, what) {
	if (!Number.isFinite(value) || value < 0) throw new CoyoteError(`${what} must be >= 0`);
}
/** Per-channel token bucket for strength increases. */
var IncreaseLimiter = class {
	rate;
	burst;
	tokens;
	lastRefill;
	constructor(rate, burst) {
		this.rate = rate;
		this.burst = burst;
		this.tokens = burst;
		this.lastRefill = Date.now();
	}
	/** Refill, then clamp an upward target to what the bucket allows. */
	allow(from, to) {
		if (to <= from) return to;
		const now = Date.now();
		this.tokens = Math.min(this.burst, this.tokens + (now - this.lastRefill) / 1e3 * this.rate);
		this.lastRefill = now;
		const affordable = Math.floor(this.tokens);
		const allowed = Math.min(to, from + affordable);
		this.tokens -= Math.max(0, allowed - from);
		return allowed;
	}
	reset() {
		this.tokens = this.burst;
		this.lastRefill = Date.now();
	}
};
/** Orchestrates transport, safety envelope, and waveform library. */
var CoyoteRuntime = class {
	config;
	log;
	server;
	scheduler;
	imported = [];
	limiters;
	baselines = {
		A: 0,
		B: 0
	};
	listeners = /* @__PURE__ */ new Set();
	cooldownUntil = 0;
	sessionTimer;
	constructor(config, log = () => {}) {
		this.config = config;
		this.log = log;
		assertLimit(config.softLimitA ?? DEFAULTS.softLimit, "softLimitA");
		assertLimit(config.softLimitB ?? DEFAULTS.softLimit, "softLimitB");
		assertNonNegative(config.sessionCooldownSec ?? DEFAULTS.sessionCooldownSec, "sessionCooldownSec");
		assertNonNegative(config.maxSessionSec ?? DEFAULTS.maxSessionSec, "maxSessionSec");
		const maxPlaySec = config.maxPlaySec ?? DEFAULTS.maxPlaySec;
		if (!Number.isFinite(maxPlaySec) || maxPlaySec <= 0) throw new CoyoteError("maxPlaySec must be > 0");
		const rate = config.increaseRatePerSec ?? DEFAULTS.increaseRatePerSec;
		const burst = config.increaseBurst ?? DEFAULTS.increaseBurst;
		if (!Number.isFinite(rate) || rate <= 0) throw new CoyoteError("increaseRatePerSec must be > 0");
		if (!Number.isFinite(burst) || burst <= 0) throw new CoyoteError("increaseBurst must be > 0");
		this.limiters = {
			A: new IncreaseLimiter(rate, burst),
			B: new IncreaseLimiter(rate, burst)
		};
		this.server = new CoyoteServer(config.server ?? {}, {
			onBound: () => this.onBound(),
			onStrength: (strength) => this.onStrength(strength),
			onDisconnect: (reason) => this.onDisconnect(reason),
			onLog: (message) => this.log(`[transport] ${message}`)
		});
		this.scheduler = new WaveScheduler(this.server, {}, (error) => {
			this.log(`[scheduler] send failed: ${String(error)}`);
		}, () => this.notify());
	}
	/** Start listening and preload the community waveform directory. */
	async start() {
		const address = await this.server.start();
		for (const wave of await loadWaveformDir(this.config.waveformDir)) this.imported.push(wave);
		if (this.imported.length > 0) this.log(`loaded ${this.imported.length} community waveform(s)`);
		return address;
	}
	/** Start (or return the pending) pairing session; enforces the cooldown. */
	async pair() {
		const remaining = this.cooldownRemainingSec();
		if (remaining > 0) throw new CoyoteError(`session cooldown active; try again in ${remaining}s`, ERROR_CODES.BIND_TIMEOUT);
		const session = await this.server.beginSession();
		this.pairingInfo = session;
		this.notify();
		return session;
	}
	/**
	* Subscribe to coarse state changes (connection, strength, playback,
	* library). Listeners run on the caller's stack and must not throw.
	* Returns an unsubscribe function.
	*/
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** Route `/gui` WebSocket connections to the browser-panel bridge. */
	mountGui(handler) {
		this.server.setGuiHandler(handler);
	}
	/** Full snapshot for tools and the GUI. */
	status() {
		const session = this.server.controlId === void 0 ? void 0 : this.currentSession();
		return {
			state: this.server.state,
			...session === void 0 ? {} : { session },
			...this.server.strength === void 0 ? {} : { strength: this.server.strength },
			effectiveLimitA: this.effectiveLimit("A"),
			effectiveLimitB: this.effectiveLimit("B"),
			playing: this.scheduler.isPlaying(),
			cooldownRemainingSec: this.cooldownRemainingSec(),
			builtinCount: BUILT_IN_WAVEFORMS.length,
			importedCount: this.imported.length
		};
	}
	/**
	* Set or adjust strength on one or both channels. Absolute `value` and
	* relative `delta` are mutually exclusive. Everything is clamped to the
	* effective limit and the increase limiter; decreases always pass.
	*/
	async setStrength(selection, request) {
		const channels = this.targets(selection);
		const strength = this.server.strength;
		const requested = {};
		const applied = {};
		const clampedBy = /* @__PURE__ */ new Set();
		if (request.value === void 0 && request.delta === void 0) throw new CoyoteError("setStrength needs either value or delta");
		if (request.value !== void 0 && (!Number.isInteger(request.value) || request.value < 0 || request.value > 200)) throw new CoyoteError(`strength value must be an integer from 0 to 200`);
		if (request.delta !== void 0 && (!Number.isInteger(request.delta) || request.delta < -200 || request.delta > 200)) throw new CoyoteError(`strength delta must be an integer within ±200`);
		for (const channel of channels) {
			const current = strength === void 0 ? this.baselines[channel] : channel === "A" ? strength.a : strength.b;
			let target;
			if (request.value !== void 0) target = request.value;
			else {
				if (strength === void 0) throw new CoyoteError("relative strength change needs a bound App; use an absolute value");
				target = current + (request.delta ?? 0);
			}
			const soft = channel === "A" ? this.softLimitA : this.softLimitB;
			const device = strength === void 0 ? 200 : channel === "A" ? strength.limitA : strength.limitB;
			const cap = Math.min(soft, device);
			if (target > soft) clampedBy.add("soft-limit");
			if (target > device) clampedBy.add("device-limit");
			target = Math.min(target, cap);
			target = Math.max(0, target);
			const limited = this.limiters[channel].allow(this.baselines[channel], target);
			if (limited < target) clampedBy.add("rate-limit");
			target = limited;
			requested[channel] = Math.max(0, Math.min(200, request.value !== void 0 ? request.value : current + (request.delta ?? 0)));
			applied[channel] = target;
		}
		for (const channel of channels) {
			await this.server.sendStrength(channel, 2, applied[channel]);
			this.baselines[channel] = applied[channel];
		}
		this.notify();
		return {
			channels,
			applied,
			requested,
			...clampedBy.size === 0 ? {} : { clampedBy: [...clampedBy].sort() }
		};
	}
	/** Resolve a source, validate it, and hand it to the scheduler. */
	async playWave(request) {
		const maxPlaySec = this.config.maxPlaySec ?? DEFAULTS.maxPlaySec;
		if (!Number.isFinite(request.durationSec) || request.durationSec <= 0) throw new CoyoteError("durationSec must be > 0");
		const durationSec = Math.min(request.durationSec, maxPlaySec);
		if (durationSec !== request.durationSec) this.log(`playback duration capped from ${request.durationSec}s to ${maxPlaySec}s`);
		const entries = this.resolveEntries(request.source);
		const scale = request.intensityScalePercent ?? 100;
		const scaled = scale === 100 ? entries : entries.map((entry) => scaleEntryIntensity(entry, scale));
		const summary = await this.scheduler.play({
			entries: scaled,
			channel: request.channel,
			mode: request.mode,
			durationSec,
			...request.mirrorB === void 0 ? {} : { mirrorB: request.mirrorB }
		});
		this.notify();
		return {
			...summary,
			entryCount: entries.length
		};
	}
	/** Stop waveform playback but keep channel strength as-is. */
	async stopWave() {
		await this.scheduler.stopAll();
		this.notify();
	}
	/** Emergency stop: zero both strengths and clear both waveform queues. */
	async panicStop() {
		await this.scheduler.stopAll();
		if (this.server.isBound()) {
			await this.server.sendStrength("A", 2, 0).catch((error) => this.log(`panic A failed: ${String(error)}`));
			await this.server.sendStrength("B", 2, 0).catch((error) => this.log(`panic B failed: ${String(error)}`));
		}
		this.baselines.A = 0;
		this.baselines.B = 0;
		this.notify();
	}
	/** End the pairing session (cooldown applies afterwards). */
	async endSession() {
		if (this.sessionTimer !== void 0) clearTimeout(this.sessionTimer);
		await this.panicStop();
		await this.server.endSession();
		this.armCooldown();
		this.notify();
	}
	/** List every playable waveform. */
	listWaveforms() {
		const builtins = BUILT_IN_WAVEFORMS.map((wave) => ({
			source: "builtin",
			id: wave.id,
			name: wave.name,
			description: `${wave.description} (${wave.nameZh})`,
			suggestedIntensityPercent: wave.suggestedIntensityPercent
		}));
		const importedWaves = this.imported.map((wave) => ({
			source: "imported",
			id: wave.name,
			name: wave.name,
			description: `community import from ${wave.source ?? "inline"}`,
			suggestedIntensityPercent: 25,
			entryCount: wave.entries.length
		}));
		return [...builtins, ...importedWaves];
	}
	/** Import community waveforms from text and persist them to the library dir. */
	async importWaveform(text, fileName) {
		const waves = parseWaveformFile(text, fileName);
		await mkdir(this.config.waveformDir, { recursive: true });
		for (const wave of waves) {
			const safe = wave.name.replace(/[^\w\u4e00-\u9fa5 -]/g, "_").slice(0, 64) || "wave";
			await writeFile(join(this.config.waveformDir, `${safe}.pulses`), JSON.stringify([{
				name: wave.name,
				pulseData: wave.entries
			}], void 0, 2));
			const existing = this.imported.findIndex((item) => item.name === wave.name);
			const record = {
				...wave,
				source: `${safe}.pulses`
			};
			if (existing >= 0) this.imported[existing] = record;
			else this.imported.push(record);
		}
		this.log(`imported ${waves.length} waveform(s)`);
		this.notify();
		return waves;
	}
	/** Permanent teardown for plugin unload. */
	async dispose() {
		if (this.sessionTimer !== void 0) clearTimeout(this.sessionTimer);
		await this.panicStop();
		await this.server.dispose();
	}
	resolveEntries(source) {
		if (source.kind === "builtin") {
			if (getBuiltIn(source.id) === void 0) throw new CoyoteError(`unknown built-in waveform: ${source.id}`);
			const windows = builtInWindows(source.id);
			if (windows.length === 0) throw new CoyoteError(`built-in waveform is empty: ${source.id}`);
			return encodeWaveSequence(windows);
		}
		if (source.kind === "imported") {
			const wave = this.imported.find((item) => item.name.toLowerCase() === source.name.trim().toLowerCase());
			if (wave === void 0) throw new CoyoteError(`unknown imported waveform: ${source.name}`);
			return [...wave.entries];
		}
		if (source.kind === "hex") {
			if (source.entries.length === 0) throw new CoyoteError("hex waveform needs at least one entry");
			return source.entries.map((entry) => {
				if (!isWaveEntryHex(entry)) throw new CoyoteError(`invalid waveform entry (need 16 hex characters): ${entry}`);
				return entry.toLowerCase();
			});
		}
		return encodeWaveSequence(composeWave(source.spec).windows);
	}
	async onBound() {
		this.log("App bound; session timer armed");
		if (this.sessionTimer !== void 0) clearTimeout(this.sessionTimer);
		this.limiters.A.reset();
		this.limiters.B.reset();
		const maxSessionSec = this.config.maxSessionSec ?? DEFAULTS.maxSessionSec;
		if (maxSessionSec > 0) this.sessionTimer = setTimeout(() => {
			this.log(`max session length (${maxSessionSec}s) reached; stopping everything`);
			this.endSession();
		}, maxSessionSec * 1e3);
		this.notify();
	}
	onStrength(strength) {
		this.baselines.A = strength.a;
		this.baselines.B = strength.b;
		this.notify();
	}
	async onDisconnect(reason) {
		this.log(`fail-safe: ${reason}; stopping playback`);
		await this.scheduler.stopAll().catch((error) => this.log(`fail-safe stop failed: ${String(error)}`));
		this.baselines.A = 0;
		this.baselines.B = 0;
		if (this.sessionTimer !== void 0) clearTimeout(this.sessionTimer);
		this.armCooldown();
		this.notify();
	}
	/** Fan out a coarse change notification; listener errors are contained. */
	notify() {
		for (const listener of [...this.listeners]) try {
			listener();
		} catch (error) {
			this.log(`change listener failed: ${String(error)}`);
		}
	}
	armCooldown() {
		const cooldown = this.config.sessionCooldownSec ?? DEFAULTS.sessionCooldownSec;
		this.cooldownUntil = Date.now() + cooldown * 1e3;
	}
	cooldownRemainingSec() {
		return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1e3));
	}
	currentSession() {
		const controlId = this.server.controlId;
		if (controlId === void 0) return void 0;
		return this.pairingInfo ?? {
			controlId,
			qrPayload: "",
			qrDataUrl: ""
		};
	}
	pairingInfo;
	get softLimitA() {
		return this.config.softLimitA ?? DEFAULTS.softLimit;
	}
	get softLimitB() {
		return this.config.softLimitB ?? DEFAULTS.softLimit;
	}
	effectiveLimit(channel) {
		const strength = this.server.strength;
		const device = strength === void 0 ? 200 : channel === "A" ? strength.limitA : strength.limitB;
		return Math.min(channel === "A" ? this.softLimitA : this.softLimitB, device);
	}
	targets(selection) {
		if (!this.server.isBound()) throw new CoyoteError("no bound App session", ERROR_CODES.NOT_BOUND);
		return selection === "both" ? ["A", "B"] : [selection];
	}
};
//#endregion
//#region src/tools/index.ts
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
const STATES = [
	"idle",
	"waiting-app",
	"bound"
];
const CHANNELS = [
	"A",
	"B",
	"both"
];
const MODES = ["once", "loop"];
const CURVES = [
	"linear",
	"sine",
	"pulse",
	"random"
];
const CLAMP_REASONS = [
	"soft-limit",
	"device-limit",
	"rate-limit"
];
const AXIS_SCHEMA = (what) => ({
	type: "object",
	required: true,
	additionalProperties: false,
	description: `${what} sweep from "from" (start) to "to" (end).`,
	properties: {
		from: {
			type: "integer",
			required: true,
			description: "Start value (inclusive)."
		},
		to: {
			type: "integer",
			required: true,
			description: "End value (inclusive)."
		},
		curve: {
			type: "string",
			required: true,
			enum: CURVES,
			description: "Interpolation shape between from and to."
		}
	}
});
const STATUS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		state: {
			type: "string",
			required: true,
			enum: STATES
		},
		session: {
			type: "object",
			additionalProperties: false,
			description: "Active pairing session.",
			properties: {
				controlId: {
					type: "string",
					required: true
				},
				qrPayload: {
					type: "string",
					required: true
				},
				qrDataUrl: {
					type: "string",
					required: true
				}
			}
		},
		strength: {
			type: "object",
			additionalProperties: false,
			description: "Latest App-reported strengths and hard limits (0..200).",
			properties: {
				a: {
					type: "integer",
					required: true
				},
				b: {
					type: "integer",
					required: true
				},
				limitA: {
					type: "integer",
					required: true
				},
				limitB: {
					type: "integer",
					required: true
				}
			}
		},
		effectiveLimitA: {
			type: "integer",
			required: true,
			description: "Cap enforced on channel A right now."
		},
		effectiveLimitB: {
			type: "integer",
			required: true,
			description: "Cap enforced on channel B right now."
		},
		playing: {
			type: "boolean",
			required: true
		},
		cooldownRemainingSec: {
			type: "number",
			required: true
		},
		builtinCount: {
			type: "integer",
			required: true
		},
		importedCount: {
			type: "integer",
			required: true
		},
		autoStim: {
			type: "object",
			additionalProperties: false,
			description: "Event-driven auto-stim block (absent fields mean \"not applicable\").",
			properties: {
				enabled: {
					type: "boolean",
					required: true,
					description: "False when autoStim is disabled in config."
				},
				armed: {
					type: "boolean",
					description: "Runtime arm switch; false drops every event."
				},
				maxIntensity: {
					type: "integer",
					description: "Auto-trigger strength cap (0..200)."
				},
				cooldownSec: {
					type: "number",
					description: "Minimum seconds between auto triggers."
				},
				inFlight: {
					type: "boolean",
					description: "A pulse (including restore) is running."
				},
				fired: {
					type: "integer",
					description: "Pulses delivered since plugin start."
				},
				skipped: {
					type: "integer",
					description: "Events dropped by a gate (cooldown/busy/not-bound/disarmed)."
				},
				lastEvent: {
					type: "string",
					description: "Domain event of the last fired pulse."
				},
				lastSkipReason: {
					type: "string",
					description: "\"<event>:<reason>\" of the last dropped event."
				},
				lastFiredAt: {
					type: "number",
					description: "Unix ms of the last fired pulse."
				},
				cooldownRemainingSec: {
					type: "number",
					description: "Seconds until the next trigger is allowed."
				}
			}
		}
	}
};
const WAVEFORM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		source: {
			type: "string",
			required: true,
			enum: ["builtin", "imported"]
		},
		id: {
			type: "string",
			required: true
		},
		name: {
			type: "string",
			required: true
		},
		description: {
			type: "string",
			required: true
		},
		suggestedIntensityPercent: {
			type: "integer",
			required: true
		},
		entryCount: { type: "integer" }
	}
};
const json = (value) => JSON.stringify(value);
/**
* Resolve a waveform name (built-in id or imported name) to a source.
* Case-insensitive on both sides; throws with the full list on a miss.
*/
function resolveByName(runtime, name) {
	const wanted = name.trim().toLowerCase();
	if (wanted.length === 0) throw new CoyoteError("waveform name cannot be empty");
	if (getBuiltIn(wanted) !== void 0) return {
		kind: "builtin",
		id: wanted
	};
	const imported = runtime.listWaveforms().find((wave) => wave.source === "imported" && wave.id.toLowerCase() === wanted);
	if (imported !== void 0) return {
		kind: "imported",
		name: imported.name
	};
	throw new CoyoteError(`unknown waveform "${name}"; call coyote_waveforms with action "list" for the full list`);
}
/** Build the eight coyote_* tool definitions around one runtime. */
function createCoyoteTools(runtime, options) {
	const defaultPlaySec = Math.min(options.defaultPlaySec, options.maxPlaySec);
	return [
		defineTool({
			name: "coyote_status",
			description: "Snapshot of the Coyote link: connection state (idle / waiting-app / bound), the pairing session with its QR, latest device-reported channel strengths and App-side hard limits, the effective per-channel caps this runtime enforces, whether waveform playback is running, the remaining pairing cooldown, and (when autoStim is enabled in config) the auto-stim block: armed flag, fire/skip counters, and last trigger. Read this first in any uncertain situation; it never changes device output.",
			parameters: {},
			output: {
				schema: STATUS_SCHEMA,
				render: (_args, value) => [{
					type: "text",
					text: json(value)
				}]
			},
			execute: async () => ({
				...runtime.status(),
				...options.autoStim === void 0 ? { autoStim: { enabled: false } } : { autoStim: options.autoStim.status() }
			}),
			presentCall: () => ({
				card: "generic",
				title: "Read Coyote status",
				kind: "read"
			})
		}),
		defineTool({
			name: "coyote_pair",
			description: "Start (or return the pending) DG-LAB pairing session and get the QR payload + renderable QR image. The user must scan the QR with the official DG-LAB App on a phone that can reach this machine over the network. The session stays pending until the App binds; a cooldown may briefly reject an immediate re-pair after a previous session ended. Pairing alone changes no device output. Show the QR through the DSH coyote GUI panel, or have the user open the qrPayload with any QR generator.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						controlId: {
							type: "string",
							required: true
						},
						qrPayload: {
							type: "string",
							required: true
						},
						qrDataUrl: {
							type: "string",
							required: true
						},
						state: {
							type: "string",
							required: true,
							enum: STATES
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`pairing session ${value.controlId} started (state: ${value.state})`,
						`qr payload: ${value.qrPayload}`,
						"Have the user scan this QR with the DG-LAB App; the QR image is rendered in the coyote GUI panel."
					].join("\n")
				}]
			},
			execute: async () => {
				return {
					...await runtime.pair(),
					state: runtime.status().state
				};
			},
			presentCall: () => ({
				card: "generic",
				title: "Start Coyote pairing",
				kind: "other"
			})
		}),
		defineTool({
			name: "coyote_disconnect",
			description: "End the pairing session: stop all waveform playback, zero both channel strengths, tell the bound App the relation is broken, and drop the QR. A short cooldown (configurable, default 3s) must pass before coyote_pair can start a new session. Prefer this over leaving a session dangling.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ended: {
							type: "boolean",
							required: true
						},
						cooldownRemainingSec: {
							type: "number",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.ended ? `session ended; cooldown ${value.cooldownRemainingSec}s before re-pairing` : json(value)
				}]
			},
			execute: async () => {
				await runtime.endSession();
				return {
					ended: true,
					cooldownRemainingSec: runtime.status().cooldownRemainingSec
				};
			},
			presentCall: () => ({
				card: "generic",
				title: "End Coyote session",
				kind: "other"
			})
		}),
		defineTool({
			name: "coyote_set_strength",
			description: "Set channel strength in the raw 0..200 protocol domain on channel A, B, or both. Pass either an absolute \"value\" or a relative \"delta\" (e.g. delta -10), never both. Safety envelope, applied before anything is sent: values are clamped to the per-channel soft limit and the App-side hard limit, and sustained increases pass an asymmetric rate limiter (decreases always go through immediately); the response reports what was actually applied and why it was reduced in \"clampedBy\". Start low (single digits) and increase gradually; ask the user before large jumps.",
			parameters: {
				channel: {
					type: "string",
					required: true,
					enum: CHANNELS,
					description: "Target channel; \"both\" drives A and B."
				},
				value: {
					type: "integer",
					description: "Absolute target strength 0..200."
				},
				delta: {
					type: "integer",
					description: "Change relative to the current strength, within ±200; requires a bound App."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						channels: {
							type: "array",
							required: true,
							items: {
								type: "string",
								enum: CHANNELS
							}
						},
						applied: {
							type: "object",
							required: true,
							additionalProperties: false,
							description: "Strength actually sent, per targeted channel.",
							properties: {
								A: { type: "integer" },
								B: { type: "integer" }
							}
						},
						requested: {
							type: "object",
							required: true,
							additionalProperties: false,
							description: "Strength the caller asked for, per targeted channel.",
							properties: {
								A: { type: "integer" },
								B: { type: "integer" }
							}
						},
						clampedBy: {
							type: "array",
							items: {
								type: "string",
								enum: CLAMP_REASONS
							}
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.clampedBy === void 0 ? `strength set on ${value.channels.join("+")}: ${Object.entries(value.applied).map(([ch, v]) => `${ch}=${v}`).join(" ")}` : `strength set on ${value.channels.join("+")}: ${Object.entries(value.applied).map(([ch, v]) => `${ch}=${v}`).join(" ")} (clamped by ${value.clampedBy.join(", ")})`
				}]
			},
			execute: async (args) => {
				if (args.value === void 0 && args.delta === void 0) throw new CoyoteError("pass either value or delta");
				return runtime.setStrength(args.channel, {
					...args.value === void 0 ? {} : { value: args.value },
					...args.delta === void 0 ? {} : { delta: args.delta }
				});
			},
			presentCall: (args) => ({
				card: "generic",
				title: `Set Coyote strength ${args.channel}${args.value !== void 0 ? ` to ${args.value}` : args.delta !== void 0 ? ` by ${args.delta > 0 ? "+" : ""}${args.delta}` : ""}`,
				kind: "other"
			})
		}),
		defineTool({
			name: "coyote_play_wave",
			description: `Play a waveform on channel A, B, or both. Exactly one source: "waveform" (a built-in preset id or an imported community name — call coyote_waveforms for the list), "spec" (a declarative synthesis: frequency sweep 10..1000ms and intensity sweep 0..100, each with a curve, plus optional on/off duty cycle), or "hex_entries" (raw 16-hex-character protocol entries). "intensity_percent" rescales the waveform's internal intensity bytes 0..100. "mirror" inverts channel B (100-x) when playing both. Playback self-terminates within "duration_seconds" (default ${defaultPlaySec}s, hard cap ${options.maxPlaySec}s); "loop" repeats the pattern until then. Strength (the 0..200 level) is a separate axis set by coyote_set_strength — a waveform still outputs nothing meaningful until the user has a comfortable strength level.`,
			parameters: {
				waveform: {
					type: "string",
					description: "Built-in preset id or imported community waveform name."
				},
				spec: {
					type: "object",
					additionalProperties: false,
					description: "Declarative synthesis spec; alternative to waveform/hex_entries.",
					properties: {
						freq: AXIS_SCHEMA("Frequency axis in milliseconds (10..1000)"),
						intensity: AXIS_SCHEMA("Intensity axis in percent (0..100)"),
						durationSec: {
							type: "number",
							required: true,
							description: "Pattern length in seconds (pattern, not playback)."
						},
						dutyCycle: {
							type: "object",
							additionalProperties: false,
							description: "Optional rhythmic on/off gating.",
							properties: {
								onSec: {
									type: "number",
									required: true,
									description: "Seconds of output per cycle."
								},
								offSec: {
									type: "number",
									required: true,
									description: "Seconds of silence per cycle."
								}
							}
						}
					}
				},
				hex_entries: {
					type: "array",
					items: { type: "string" },
					description: "Raw protocol entries, each exactly 16 hex characters; alternative to waveform/spec."
				},
				channel: {
					type: "string",
					enum: CHANNELS,
					description: "Target channel. Default A."
				},
				mode: {
					type: "string",
					enum: MODES,
					description: "once plays the pattern once; loop repeats it. Default once."
				},
				duration_seconds: {
					type: "number",
					description: `Playback duration in seconds (default ${defaultPlaySec}, cap ${options.maxPlaySec}).`
				},
				intensity_percent: {
					type: "integer",
					description: "Scale the waveform intensity bytes by 0..100 percent. Default 100."
				},
				mirror: {
					type: "boolean",
					description: "Invert channel B (100 - x) when channel is \"both\". Default false."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						channels: {
							type: "array",
							required: true,
							items: {
								type: "string",
								enum: CHANNELS
							}
						},
						mode: {
							type: "string",
							required: true,
							enum: MODES
						},
						durationSec: {
							type: "number",
							required: true
						},
						segments: {
							type: "integer",
							required: true
						},
						entryCount: {
							type: "integer",
							required: true
						},
						source: {
							type: "string",
							required: true,
							description: "Which source was resolved and played."
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `playing ${value.source} on ${value.channels.join("+")} (${value.mode}, ${value.durationSec}s, ${value.entryCount} entries)`
				}]
			},
			execute: async (args) => {
				if ([
					args.waveform,
					args.spec,
					args.hex_entries
				].filter((v) => v !== void 0).length !== 1) throw new CoyoteError("pass exactly one of waveform, spec, or hex_entries");
				const source = args.waveform !== void 0 ? resolveByName(runtime, args.waveform) : args.spec !== void 0 ? {
					kind: "spec",
					spec: args.spec
				} : {
					kind: "hex",
					entries: args.hex_entries
				};
				const sourceLabel = args.waveform !== void 0 ? `${getBuiltIn(args.waveform.trim().toLowerCase()) !== void 0 ? "builtin" : "imported"}:${args.waveform.trim()}` : args.spec !== void 0 ? "spec" : "hex";
				return {
					...await runtime.playWave({
						source,
						channel: args.channel ?? "A",
						mode: args.mode ?? "once",
						durationSec: args.duration_seconds ?? defaultPlaySec,
						...args.intensity_percent === void 0 ? {} : { intensityScalePercent: args.intensity_percent },
						...args.mirror === void 0 ? {} : { mirrorB: args.mirror }
					}),
					source: sourceLabel
				};
			},
			presentCall: (args) => ({
				card: "generic",
				title: args.waveform !== void 0 ? `Play Coyote wave ${args.waveform} on ${args.channel ?? "A"}` : `Play Coyote wave ${args.spec !== void 0 ? "(spec)" : "(hex)"} on ${args.channel ?? "A"}`,
				kind: "other"
			})
		}),
		defineTool({
			name: "coyote_stop_wave",
			description: "Stop waveform playback on both channels but keep the current channel strength. Use this to end a pattern without dropping the strength level; use coyote_panic_stop when output must stop immediately.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { stopped: {
						type: "boolean",
						required: true
					} }
				},
				render: () => [{
					type: "text",
					text: "waveform playback stopped; strength unchanged"
				}]
			},
			execute: async () => {
				await runtime.stopWave();
				return { stopped: true };
			},
			presentCall: () => ({
				card: "generic",
				title: "Stop Coyote waveform",
				kind: "other"
			})
		}),
		defineTool({
			name: "coyote_panic_stop",
			description: "Emergency stop: immediately clear both waveform queues and set both channel strengths to 0. Idempotent and safe in every state. Reach for this on any unexpected device reaction, user discomfort, or uncertainty — it never makes things worse.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { stopped: {
						type: "boolean",
						required: true
					} }
				},
				render: () => [{
					type: "text",
					text: "panic stop: waveforms cleared, both strengths at 0"
				}]
			},
			execute: async () => {
				await runtime.panicStop();
				return { stopped: true };
			},
			presentCall: () => ({
				card: "generic",
				title: "Coyote PANIC STOP",
				kind: "other"
			})
		}),
		defineTool({
			name: "coyote_waveforms",
			description: "Waveform library. action \"list\" returns every playable waveform (built-in presets with descriptions and suggested starting intensity, plus imported community waveforms) — the ids feed coyote_play_wave. action \"import\" parses Game-Hub `.pulses` JSON (an array of {name, pulseData}) or a bare hex list from \"text\" and persists it to the library, then returns the full updated list.",
			parameters: {
				action: {
					type: "string",
					required: true,
					enum: ["list", "import"],
					description: "List the library or import new waveforms from text."
				},
				text: {
					type: "string",
					description: "File content to import (Game-Hub .pulses JSON or bare hex list); required for action \"import\"."
				},
				file_name: {
					type: "string",
					description: "Label for the imported file; used for bare-hex naming."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						imported: {
							type: "array",
							description: "Names persisted by action \"import\".",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									name: {
										type: "string",
										required: true
									},
									entryCount: {
										type: "integer",
										required: true
									}
								}
							}
						},
						waveforms: {
							type: "array",
							required: true,
							items: WAVEFORM_SCHEMA
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.imported === void 0 ? `${value.waveforms.length} waveforms: ${value.waveforms.map((wave) => wave.id).join(", ")}` : `imported ${value.imported.map((wave) => wave.name).join(", ")}; library now ${value.waveforms.length} waveforms`
				}]
			},
			execute: async (args) => {
				if (args.action === "import") {
					if (args.text === void 0 || args.text.trim().length === 0) throw new CoyoteError("action \"import\" needs the file content in text");
					return {
						imported: (await runtime.importWaveform(args.text, args.file_name ?? "pasted.pulses")).map((wave) => ({
							name: wave.name,
							entryCount: wave.entries.length
						})),
						waveforms: runtime.listWaveforms()
					};
				}
				return { waveforms: runtime.listWaveforms() };
			},
			presentCall: (args) => ({
				card: "generic",
				title: args.action === "import" ? "Import Coyote waveforms" : "List Coyote waveforms",
				kind: args.action === "import" ? "other" : "read"
			})
		})
	];
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "dsh-coyote";
/** Harness services required by the model-facing consumer. */
const inject = ["tools"];
const Config = z.object({
	host: z.string().default("0.0.0.0"),
	port: z.number().default(9999),
	publicWsUrl: z.string(),
	waveformDir: z.string().default("coyote-waveforms"),
	softLimitA: z.number().default(100),
	softLimitB: z.number().default(100),
	sessionCooldownSec: z.number().default(3),
	maxSessionSec: z.number().default(3600),
	maxPlaySec: z.number().default(600),
	defaultPlaySec: z.number().default(30),
	increaseRatePerSec: z.number().default(40),
	increaseBurst: z.number().default(40),
	autoStim: autoStimSchema()
});
/** Validate the resolved values the runtime cannot check itself. @internal */
function resolveConfig(config) {
	const resolved = config;
	if (!(resolved.maxPlaySec > 0)) throw new Error("dsh-coyote: maxPlaySec must be > 0");
	if (!(resolved.defaultPlaySec > 0)) throw new Error("dsh-coyote: defaultPlaySec must be > 0");
	if (resolved.defaultPlaySec > resolved.maxPlaySec) throw new Error("dsh-coyote: defaultPlaySec cannot exceed maxPlaySec");
	if (resolved.port !== 0 && (!Number.isSafeInteger(resolved.port) || resolved.port < 1 || resolved.port > 65535)) throw new Error("dsh-coyote: port must be 0 (OS-assigned) or a valid TCP port");
	if (resolved.waveformDir.trim() === "") throw new Error("dsh-coyote: waveformDir cannot be empty");
	if (resolved.publicWsUrl !== void 0) try {
		const protocol = new URL(resolved.publicWsUrl).protocol;
		if (protocol !== "ws:" && protocol !== "wss:") throw new Error("unsupported protocol");
	} catch {
		throw new Error("dsh-coyote: publicWsUrl must be a ws:// or wss:// URL");
	}
	return resolved;
}
/** Register the eight coyote_* tools and mount the GUI bridge (+ auto-stim when enabled). */
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	const runtime = new CoyoteRuntime({
		server: {
			host: resolved.host,
			port: resolved.port,
			...resolved.publicWsUrl === void 0 ? {} : { publicWsUrl: resolved.publicWsUrl }
		},
		waveformDir: resolved.waveformDir,
		softLimitA: resolved.softLimitA,
		softLimitB: resolved.softLimitB,
		sessionCooldownSec: resolved.sessionCooldownSec,
		maxSessionSec: resolved.maxSessionSec,
		maxPlaySec: resolved.maxPlaySec,
		increaseRatePerSec: resolved.increaseRatePerSec,
		increaseBurst: resolved.increaseBurst
	}, (message) => ctx.logger.info(`dsh-coyote: ${message}`));
	let autoStimEngine;
	if (resolved.autoStim?.enabled === true) {
		const autoStimConfig = normalizeAutoStimConfig(resolved.autoStim);
		autoStimEngine = new AutoStimEngine(runtime, autoStimConfig, (message) => ctx.logger.info(`dsh-coyote: ${message}`));
		attachAutoStim(ctx, new EventMapper({ tickIntervalSec: autoStimConfig.tickIntervalSec }), autoStimEngine, (message) => ctx.logger.warn(`dsh-coyote: ${message}`));
	}
	const bridge = new GuiBridge(runtime, autoStimEngine);
	runtime.mountGui((socket) => bridge.handleConnection(socket));
	const unsubscribeAutoStim = autoStimEngine?.subscribe(() => bridge.broadcast());
	ctx.effect(() => () => {
		unsubscribeAutoStim?.();
		autoStimEngine?.dispose();
		bridge.dispose();
		runtime.dispose();
	}, "dsh-coyote teardown");
	for (const tool of createCoyoteTools(runtime, {
		defaultPlaySec: resolved.defaultPlaySec,
		maxPlaySec: resolved.maxPlaySec,
		...autoStimEngine === void 0 ? {} : { autoStim: autoStimEngine }
	})) ctx.tools.register(tool);
	runtime.start().then((address) => ctx.logger.info(`dsh-coyote: transport ready on ${address.host}:${address.port} (panel path /gui)`), (error) => ctx.logger.error(`dsh-coyote: transport failed to start: ${String(error)}`));
}
//#endregion
export { AUTO_STIM_EVENTS, AutoStimEngine, BUILT_IN_WAVEFORMS, Config, CoyoteError, CoyoteRuntime, CoyoteServer, DEFAULT_AUTO_STIM_RULES, DEFAULT_AUTO_STIM_SETTINGS, EventMapper, GuiBridge, STRENGTH_MAX, STRENGTH_MIN, apply, attachAutoStim, autoStimSchema, composeWave, createCoyoteTools, inject, name, normalizeAutoStimConfig, resolveConfig };
