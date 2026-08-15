# Changelog

**English** · [**简体中文**](CHANGELOG.zh-CN.md)

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-08-15

### Added

- **Auto-stim** (`src/auto-stim/`): opt-in event-driven stimulation. A mapper reduces the DSH session event firehose plus `agent/error` / `agent/status` to eleven domain events (`turn_start`, `assistant_start`, `stream_tick`, `tool_call`, `tool_error`, `agent_error`, `turn_end_completed`, `turn_end_aborted`, `turn_end_max_tokens`, `todo_clear`, `agent_idle`) with per-turn error dedup, tick throttling, and edge detection; the engine fires one bounded **absolute transient pulse** per enabled rule — boost to `min(rule.intensity, maxIntensity)`, play the waveform once, restore the pre-pulse baseline — behind a gate chain (rule enabled → armed → not busy → cooldown → App bound) that drops and counts instead of queueing.
- **Auto-stim config** (`autoStim.*`): `enabled` (default false), `maxIntensity` (30), `cooldownSec` (5), `tickIntervalSec` (5), `restoreBaseline` (true), and per-event rule overrides; unknown event names fail at startup with the valid list; every default intensity stays ≤ `maxIntensity`.
- **GUI**: new 自动电击 section (live armed state, in-flight pulse indicator, fire/skip counters, last event and skip reason, cooldown) with a 布防/解除 toggle over the `auto` op; appears only when auto-stim is enabled.
- **Tools**: `coyote_status` carries an `autoStim` block (armed, counters, cooldown remaining) when the feature is enabled, or `{enabled: false}` otherwise.

### Fixed

- Auto-stim teardown cuts an in-flight pulse short (`stopWave`) and restores the baseline from any pulse phase, so unloading the plugin can never strand a boosted strength.
- A waveform name that is neither built-in nor imported fails before any device command (no ghost boost) and is logged per pulse instead of crashing the host.
- A pulse failing after the boost (e.g. App dropped mid-play) now restores the baseline before surfacing the error.

## [0.1.0] — 2026-08-15

First public release.

### Added

- **Transport**: DG-LAB V3 socket server + control-terminal role — QR pairing (32-hex control id, LAN-address-aware QR URL, `publicWsUrl` override), bind handshake, 60 s heartbeats, break-frame session end, send-failure fail-safe, `/gui` panel route.
- **Safety envelope** (`CoyoteRuntime`): per-channel soft limits with dynamic `min(soft, device-limit)` clamping; asymmetric increase rate limiter (token bucket; decreases always pass); adjustable session cooldown (default 3 s, 0 disables); session hard cap (default 3600 s); playback hard cap (default 600 s) with device-queue clearing at expiry; disconnect fail-safe stopping playback and zeroing state.
- **Waveforms**: deterministic parametric composer (frequency 10..1000 ms and intensity 0..100 sweeps, `linear/sine/pulse/random` curves, seeded `random`, optional on/off duty cycle); 12 built-in presets with suggested starting intensities; Game-Hub `.pulses` / bare-hex import with validation, persistence, and startup reload; segmenting scheduler (70 entries/wire message, lead-ahead feeding, clear-gap per the official jitter tip).
- **Eight `coyote_*` tools**: `coyote_status`, `coyote_pair`, `coyote_disconnect`, `coyote_set_strength`, `coyote_play_wave`, `coyote_stop_wave`, `coyote_panic_stop`, `coyote_waveforms` — with schema-validating outputs, teaching descriptions, and call cards.
- **Web panel** (`client/index.js`): no-build closure bundle for the DSH module loader; live status/QR/strength/waveform controls, reconnecting `/gui` connection, panic button; styled against DSH CSS variables; registered into the `sidebar.footer.action` slot with `dsh.client.inject` declared.
- **Tests**: 114 tests across 13 files — protocol units, waveform units, scheduler timing, transport against a protocol-faithful MockApp, runtime safety behaviors, tool schemas, `/gui` bridge, plugin entry, and an offline client harness with a mini React.
- **Docs**: bilingual README (EN/zh-CN), CHANGELOG, NOTICE, MIT LICENSE.
