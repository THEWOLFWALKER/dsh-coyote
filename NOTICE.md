# Third-Party Notices

This project is standalone original code; it does not incorporate source from the projects below, but their public documentation and ecosystem conventions served as the technical basis for interoperability and design decisions. We thank their authors.

## DG-LAB-OPENSOURCE

- Project: <https://github.com/ZGQ-inc/DG-LAB-OPENSOURCE>
- Used for: the V3 socket protocol (frame shape, bind/break/heartbeat flows, error codes, 1950-char frame cap, 100-entry pulse cap), the V3 waveform entry encoding (8 bytes: 4 frequency + 4 intensity, 25 ms windows, 10..240 compressed period domain), and the QR payload format.
- License: please refer to the repository.

## DG-Lab-Coyote-Game-Hub

- Project: <https://github.com/SweetSmellFox/DG-Lab-Coyote-Game-Hub>
- Used for: the community waveform `.pulses` interchange format (`[{ name, pulseData: ["16-hex", …] }]`) supported by the importer.
- License: please refer to the repository.

## DeepSeek Harness ecosystem plugins

- `dsh-community-hot` and `dsh-client-ui-writing` informed the client-plugin conventions followed here: the `window.__ModuleLoader__.load({ id, factory })` handoff, the guarded test hook, the `dsh.client` manifest (`platform`, `inject`), slot registration via `ctx.slots.inject` / `ctx.slots.register`, and DSH CSS alias variables for theming.
- Used as references only; no source copied.

## Runtime dependencies

- [`ws`](https://github.com/websockets/ws) (MIT) — WebSocket server and test clients.
- [`qrcode`](https://github.com/soldair/node-qrcode) (MIT) — QR data-URL rendering.

Peer dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`) are provided by the DeepSeek Harness host at runtime.
