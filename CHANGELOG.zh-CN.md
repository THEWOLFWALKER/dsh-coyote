# 更新日志（简体中文）

本项目的所有重要变更都在此记录。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-08-15

### 新增

- **自动电击**（`src/auto-stim/`）：可选的事件驱动电击。mapper 把 DSH 会话事件流与 `agent/error` / `agent/status` 归约为十一个领域事件（`turn_start`、`assistant_start`、`stream_tick`、`tool_call`、`tool_error`、`agent_error`、`turn_end_completed`、`turn_end_aborted`、`turn_end_max_tokens`、`todo_clear`、`agent_idle`），带按回合错误去重、tick 节流与边沿检测；engine 对每条启用的规则发出一个有界的**绝对瞬态脉冲**——抬升到 `min(规则 intensity, maxIntensity)`、波形播放一次、恢复脉冲前基线——闸门链（规则启用 → 布防 → 非忙碌 → 冷却 → App 已绑定）拦截的事件丢弃并计数，绝不排队。
- **自动电击配置**（`autoStim.*`）：`enabled`（默认 false）、`maxIntensity`（30）、`cooldownSec`（5）、`tickIntervalSec`（5）、`restoreBaseline`（true）与逐事件规则覆盖；未知事件名启动时带完整合法列表报错；所有默认强度 ≤ `maxIntensity`。
- **GUI**：新增自动电击区块（实时布防状态、脉冲输出指示、触发/跳过计数、最近事件与跳过原因、冷却）与 `auto` 操作的布防/解除开关；仅在启用自动电击时出现。
- **工具**：`coyote_status` 在功能启用时携带 `autoStim` 块（布防、计数、剩余冷却），否则为 `{enabled: false}`。

### 修复

- 自动电击卸载时截断进行中的脉冲（`stopWave`）并从任意脉冲阶段恢复基线，插件卸载不会遗留抬升的强度。
- 既非内置也非导入的波形名在任何设备指令之前失败（无幽灵抬升），按脉冲记日志而非拖垮宿主。
- 抬升之后脉冲失败（如播放中途 App 掉线）先恢复基线再上抛错误。

## [0.1.0] — 2026-08-15

首次公开发布。

### 新增

- **传输层**：DG-LAB V3 socket 服务端 + 控制终端角色——二维码配对（32 位十六进制控制 id、识别局域网地址的二维码 URL、`publicWsUrl` 覆盖）、绑定握手、60 秒心跳、break 帧结束会话、发送失败 fail-safe、`/gui` 面板路由。
- **安全边界**（`CoyoteRuntime`）：每通道软上限并动态 `min(软上限, 设备上限)` 钳制；非对称升速限流器（令牌桶；降速始终放行）；可调会话冷却（默认 3 秒，0 禁用）；会话硬上限（默认 3600 秒）；播放硬上限（默认 600 秒，到期清空设备队列）；断连 fail-safe 停止播放并归零状态。
- **波形**：确定性参数化合成器（频率 10..1000ms 与强度 0..100 扫描、`linear/sine/pulse/random` 曲线、可播种 `random`、可选开关占空比）；12 个内置预设并附建议起始强度；Game-Hub `.pulses` / 裸十六进制导入（带校验、持久化与启动重载）；分段调度器（每条线上消息 70 条、提前喂入、按官方抖动提示清除间隔）。
- **八个 `coyote_*` 工具**：`coyote_status`、`coyote_pair`、`coyote_disconnect`、`coyote_set_strength`、`coyote_play_wave`、`coyote_stop_wave`、`coyote_panic_stop`、`coyote_waveforms`——带 schema 校验的输出、教学式描述与调用卡片。
- **网页面板**（`client/index.js`）：面向 DSH 模块加载器的免构建闭包 bundle；实时状态/二维码/强度/波形控制、自动重连的 `/gui` 连接、紧急停止按钮；按 DSH CSS 变量主题化；注册进 `sidebar.footer.action` 插槽并声明 `dsh.client.inject`。
- **测试**：13 个文件 114 个测试——协议单元、波形单元、调度器时序、针对协议忠实 MockApp 的传输测试、运行时安全行为、工具 schema、`/gui` 桥、插件入口，以及带迷你 React 的离线客户端测试装置。
- **文档**：双语 README（英文/简体中文）、更新日志、第三方声明、MIT 许可证。
