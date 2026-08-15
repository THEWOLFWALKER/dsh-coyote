# dsh-coyote

**English** · [**简体中文**](README.zh-CN.md)

Agent- and GUI-controlled [DG-LAB Coyote](https://www.dungeon-lab.com/) e-stim plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

One safety envelope serves two faces with equal bounds: eight model-facing `coyote_*` tools and a DSH-aligned browser panel. Neither can bypass soft limits, the asymmetric increase rate limiter, session cooldown, playback caps, or the disconnect fail-safe.

> Adults only. This plugin controls a real e-stim power box. Read [Safety](#safety) before use.

## How it works

```
DSH agent ──coyote_* tools──┐
                             ├─▶ CoyoteRuntime (safety envelope) ─▶ V3 socket server ─▶ DG-LAB App (QR) ─▶ Coyote device
DSH web GUI ──/gui bridge───┘         soft limits · rate limit · cooldown · hard caps · fail-safe
```

The plugin is the WebSocket *server* side of the official DG-LAB V3 socket protocol: pairing mints a QR the official App scans; from then on the plugin is the control terminal and the App relays commands to the device.

## Quick start

```bash
dsh plugin --profile web add dsh-coyote
```

The plugin's bundle patch inserts its row automatically — zero config needed, the defaults below apply. To tune, target the inserted row in your profile overlay:

```yaml
- id: coyote
  config:
    port: 9999          # WebSocket port; the phone must reach this machine
    softLimitA: 60      # agent-side caps, 0..200 — tune to the user's comfort
    softLimitB: 60
```

1. The DSH web GUI shows a ⚡ **Coyote** button in the sidebar footer — it opens the control panel.
2. Tap **开始配对** (pair); a QR appears.
3. Scan it with the official **DG-LAB App** on a phone on the same network (or set `publicWsUrl` behind a `wss://` reverse proxy).
4. The panel and the agent can now both drive the device — always within the same limits.

## The eight tools

| Tool | What it does |
|---|---|
| `coyote_status` | Full snapshot: link state, QR, device strengths, effective caps, cooldown. Read-only. |
| `coyote_pair` | Start pairing; returns QR payload + renderable QR image. |
| `coyote_disconnect` | End the session: stop everything, break the App relation, arm the cooldown. |
| `coyote_set_strength` | Set A/B/both in the raw 0..200 domain. Absolute `value` or relative `delta`. Reports clamping. |
| `coyote_play_wave` | Play by preset name, declarative `spec`, or raw hex entries; `once`/`loop`, intensity scale, B-mirror. |
| `coyote_stop_wave` | Stop waveform playback, keep strength levels. |
| `coyote_panic_stop` | Emergency: clear both waveform queues, zero both strengths. Idempotent, always safe. |
| `coyote_waveforms` | List the library; import Game-Hub `.pulses` JSON or bare hex lists. |

Tool descriptions teach the safety model, so the model behaves well without reading source.

## Safety model

Every bound — enforced in `CoyoteRuntime` before anything is sent:

| Mechanism | Default | Effect |
|---|---|---|
| Soft limits `softLimitA/B` | 100 | Agent-side cap per channel, 0..200. |
| Device hard limits | App-side | Effective cap = `min(soft, device)`; re-read on every report, so lowering the limit on the phone wins immediately. |
| Asymmetric rate limit | 40/s, burst 40 | Strength **increases** draw from a refilling token bucket; **decreases always pass instantly**. |
| Session cooldown `sessionCooldownSec` | 3 s (adjustable, 0 disables) | A fresh pairing must wait after the previous session ended. Prevents rapid re-pair abuse. |
| Session hard cap `maxSessionSec` | 3600 s (0 disables) | One bound session auto-ends (stop + zero). |
| Playback cap `maxPlaySec` | 600 s | Every playback self-terminates; the device queue is cleared at the cap. |
| Disconnect fail-safe | always on | App socket loss stops playback, clears queues, resets state. |

The GUI panel goes through the identical runtime — the browser cannot bypass the agent's bounds, and vice versa.

## Waveforms

- **12 built-in presets** (呼吸 Breathing, 心跳 Heartbeat, 惩罚 Punish, …) with suggested starting intensities, synthesized deterministically from declarative specs (frequency sweep 10..1000 ms, intensity sweep 0..100, curves `linear|sine|pulse|random`, optional on/off duty cycle).
- **Community import**: paste [Game-Hub](https://github.com/SweetSmellFox/DG-Lab-Coyote-Game-Hub) `.pulses` JSON (`[{name, pulseData:[hex…]}]`) or bare hex lists; validated, persisted under `waveformDir`, reloaded on start. Re-importing a name replaces it.

## Configuration

All fields optional; defaults shown.

| Key | Default | Notes |
|---|---|---|
| `host` | `0.0.0.0` | Bind address. `0.0.0.0` lets LAN phones reach the QR URL. |
| `port` | `9999` | WebSocket port. `0` = OS-assigned. |
| `publicWsUrl` | — | QR base override for `wss://` reverse proxies. |
| `waveformDir` | `coyote-waveforms` | Where community imports persist. |
| `softLimitA` / `softLimitB` | `100` | Per-channel agent-side caps, 0..200. |
| `sessionCooldownSec` | `3` | Cooldown before re-pairing; `0` disables. |
| `maxSessionSec` | `3600` | Hard cap per bound session; `0` disables. |
| `maxPlaySec` | `600` | Hard cap per playback. |
| `defaultPlaySec` | `30` | Duration when a tool call omits one. |
| `increaseRatePerSec` | `40` | Sustained increase speed (units/s). |
| `increaseBurst` | `40` | Immediate increase budget (units). |

## Architecture

```
src/
  protocol/   pure V3 codec: frames, wave entries, QR payload
  waveform/   composer (spec→windows), library (12 presets), importer, scheduler
  transport/  WebSocket server + control-terminal role (bind, heartbeat, fail-safe)
  runtime/    the safety envelope everything routes through
  gui/        /gui bridge: JSON ops ↔ runtime, broadcasts status
  tools/      the 8 coyote_* tool definitions
client/index.js   browser panel (no build step, loader-injected React, DSH CSS variables)
tests/            114 tests: unit + protocol-level MockApp + offline client harness
```

Design rules: pure protocol functions, one safety choke point, thin honest tools, no over-design. Evidence for every protocol decision is the official [DG-LAB-OPENSOURCE](https://github.com/ZGQ-inc/DG-LAB-OPENSOURCE) socket/V3 documentation.

## Development

```bash
pnpm install
pnpm test         # 114 tests
pnpm typecheck
pnpm build        # lib/ (tsdown)
```

Note: `pnpm build` prints one tsdown↔rolldown upstream validation warning (`Invalid input options … "define"`); it is cosmetic, the artifacts are correct.

## Safety

This plugin drives a real e-stim device on a human body. Follow the DG-LAB safety guidance that ships with your device. In short:

- Start from single-digit strength; increase gradually; agree on limits and a stop signal with the user **before** starting.
- Keep the App-side hard limit as the final guard — the runtime honors it dynamically.
- Chest, neck, and head are unsafe electrode placements; stop immediately at any discomfort or unexpected behavior (`coyote_panic_stop` never makes things worse).
- Use only with informed adult consent.

## License

[MIT](LICENSE) · third-party notices in [NOTICE.md](NOTICE.md)
