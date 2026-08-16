# dsh-coyote

[**English**](README.md) · **简体中文**

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![Cordis](https://img.shields.io/badge/Cordis-插件开发-FF6B6B?style=flat-square)
![pnpm](https://img.shields.io/badge/pnpm-F69220?style=flat-square&logo=pnpm&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)

![npm version](https://img.shields.io/npm/v/dsh-coyote?style=flat-square&logo=npm&logoColor=white)
![tests](https://img.shields.io/badge/tests-148-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)
![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-官方收录-00B4D8?style=flat-square)

![18+](https://img.shields.io/badge/18%2B-仅限成年人-E91E63?style=flat-square)
![安全](https://img.shields.io/badge/panic%20stop-永远安全-00C853?style=flat-square)
![电击](https://img.shields.io/badge/bzz%20bzz-zap-FF9800?style=flat-square)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 [DG-LAB 郊狼](https://www.dungeon-lab.com/)电击控制插件，同时提供 Agent 工具与网页 GUI 两条控制面。

一个安全边界（`CoyoteRuntime`）同时约束两张面孔：八个模型侧 `coyote_*` 工具与浏览器面板。任何一方都无法绕过软上限、非对称升速限制、会话冷却、播放硬上限与断连即停。v0.2 起另有一个可选的**自动电击**层，把 agent 事件（工具调用、报错、回合结束……）映射为有界脉冲 —— 见[自动电击](#自动电击)。

> 仅限成年人。本插件控制真实电刺激设备，使用前请阅读[安全须知](#安全须知)。

## 工作原理

```
DSH Agent ─coyote_* 工具──┐
                           ├─▶ CoyoteRuntime（安全边界）─▶ V3 WebSocket 服务 ─▶ DG-LAB App（扫码）─▶ 郊狼设备
DSH 网页 GUI ─/gui 桥接───┘      软上限 · 升速限制 · 冷却 · 硬上限 · 断连即停
agent 事件 ─自动电击（可选）──┘   布防闸门 · 冷却 · maxIntensity 封顶 · 基线恢复
```

插件扮演官方 DG-LAB V3 socket 协议的 WebSocket **服务端**：配对时生成二维码，官方 App 扫码后，插件即成为控制终端，App 负责把指令转发到设备。

## 快速开始

```bash
dsh plugin --profile web add dsh-coyote
```

插件的 bundle patch 会自动插入自己的行 —— 无需任何配置即可使用，下方默认值自动生效。需要调参时，在 profile overlay 中按行 id 定位：

```yaml
- id: coyote
  config:
    port: 9999          # WebSocket 端口；手机必须能访问本机
    softLimitA: 60      # 通道软上限，0..200 —— 按使用者舒适度调整
    softLimitB: 60
```

1. DSH 网页侧边栏底部出现 ⚡ **Coyote** 按钮，点击打开控制面板。
2. 点 **开始配对**，出现二维码。
3. 用官方 **DG-LAB App**（同局域网）扫码；反向代理场景可配置 `publicWsUrl`（`wss://`）。
4. 面板与 Agent 即可共同控制设备 —— 始终在同一个限制之内。

## 八个工具

| 工具 | 功能 |
|---|---|
| `coyote_status` | 完整快照：链路状态、二维码、设备强度、生效上限、剩余冷却，以及（启用时的）自动电击块。只读。 |
| `coyote_pair` | 开始配对；返回二维码内容与可渲染二维码图。 |
| `coyote_disconnect` | 结束会话：停止一切、断开 App 关系、进入冷却。 |
| `coyote_set_strength` | 在 0..200 原始域设置 A/B/双通道。绝对 `value` 或相对 `delta`，返回实际施加值与钳制原因。 |
| `coyote_play_wave` | 按预设名、声明式 `spec` 或原始 hex 播放；`once`/`loop`、强度缩放、B 通道镜像。 |
| `coyote_stop_wave` | 停止波形播放，保留通道强度。 |
| `coyote_panic_stop` | 紧急停止：清空双通道波形队列、强度归零。幂等，任何状态下调用都安全。 |
| `coyote_waveforms` | 波形库列表；导入 Game-Hub `.pulses` JSON 或裸 hex 列表。 |

工具描述本身就在讲解安全模型，模型无需读源码即可正确使用。

## 安全模型

所有约束在 `CoyoteRuntime` 中、于任何指令发出之前生效：

| 机制 | 默认值 | 效果 |
|---|---|---|
| 软上限 `softLimitA/B` | 100 | 每通道 Agent 侧上限，0..200。 |
| 设备硬上限 | App 侧 | 生效上限 = `min(软上限, 设备上限)`；每次上报都重读，手机端调低立即生效。 |
| 非对称升速限制 | 40/秒，突发 40 | 强度**上调**走令牌桶；**下调永远立即放行**。 |
| 会话冷却 `sessionCooldownSec` | 3 秒（可调，0 关闭） | 上个会话结束后需等待才能重新配对，防止滥用。 |
| 会话硬上限 `maxSessionSec` | 3600 秒（0 关闭） | 单次绑定会话到时自动结束（停止并归零）。 |
| 播放硬上限 `maxPlaySec` | 600 秒 | 每次播放自动终止，到期同时清空设备队列。 |
| 断连即停 | 始终开启 | App 断开即停播、清队列、重置状态。 |

GUI 面板走完全相同的 runtime —— 浏览器绕不过 Agent 的限制，反之亦然。

## 波形

- **12 个内置预设**（呼吸、心跳、惩罚、电锯……）自带建议起始强度，由声明式规格确定性合成（频率扫 10..1000 ms、强度扫 0..100，曲线 `linear|sine|pulse|random`，可选占空比节奏）。
- **社区波形导入**：粘贴 [Game-Hub](https://github.com/SweetSmellFox/DG-Lab-Coyote-Game-Hub) `.pulses` JSON（`[{name, pulseData:[hex…]}]`）或裸 hex 列表；校验后持久化到 `waveformDir`，启动时自动加载。同名重导入为覆盖更新。

## 自动电击

可选的事件驱动电击（v0.2）：插件监听 DSH 会话事件流与 `agent/error` / `agent/status` 运行时事件，把它们归约为十一个封闭的领域事件，对每条启用的规则发出一个有界脉冲。默认关闭 —— `autoStim.enabled: true` 之前不监听任何事件、面板也不出现该区块。

**每个脉冲都是绝对瞬态**：通道强度先抬升到 `min(规则 intensity, maxIntensity)`（runtime 仍会钳到软/设备上限与升速限制），波形播放一次，然后恢复脉冲前强度。刚配对、强度为 0 的设备也能直接工作。

闸门链 —— 每个闸门都通过才触发，被拦下的事件直接丢弃并计数，绝不排队：

| 闸门 | 效果 |
|---|---|
| 规则启用 | 未启用规则的事件不做任何事。 |
| 布防 | GUI 的布防/解除开关；解除后事件静默丢弃。 |
| 非忙碌 | 同一时刻最多一个脉冲（含恢复期）。 |
| 冷却 | 自动触发之间默认最少 5 秒。 |
| App 已绑定 | 无设备连接则跳过并计数。 |
| maxIntensity | 独立封顶（默认 30），叠加在每条规则之上。 |

默认规则表（所有强度 ≤ 默认 `maxIntensity` 30）：

| 事件 | 触发时机 | 默认 |
|---|---|---|
| `turn_start` | 新 agent 回合开始 | tap @12、2 秒、开 |
| `assistant_start` | 回合内第一个流式块 | tap @15、2 秒、开 |
| `stream_tick` | 流式输出每 `tickIntervalSec`（5 秒） | tremor @15、2 秒、**关** |
| `tool_call` | 模型调用工具 | tap @20、2 秒、开 |
| `tool_error` | 工具调用失败 | punish @25、6 秒、开 |
| `agent_error` | 回合失败（两个事件源按回合去重） | punish @30、8 秒、开 |
| `turn_end_completed` | 回合正常完成 | heartbeat @20、4 秒、开 |
| `turn_end_aborted` | 回合中止 / 打断 / 阻塞 | calm @12、3 秒、关 |
| `turn_end_max_tokens` | 回合触到 token 上限 | saw @20、3 秒、关 |
| `todo_clear` | 待办全部完成（每个清单只触发一次） | heartbeat @18、4 秒、开 |
| `agent_idle` | agent 运行→空闲边沿 | calm @12、4 秒、关 |

```yaml
- id: coyote
  config:
    autoStim:
      enabled: true          # 总开关，显式开启才生效
      maxIntensity: 30       # 所有规则之上的封顶，1..200
      cooldownSec: 5         # 自动触发之间的最小间隔秒数
      tickIntervalSec: 5     # stream_tick 节流间隔
      restoreBaseline: true  # 每个脉冲后恢复脉冲前强度
      events:
        tool_error: { intensity: 25, durationSec: 6, waveform: punish, channel: A }
        agent_error: { enabled: false }   # 单字段覆盖，其余继承默认
```

未知事件名会在启动时带着完整合法列表报错。波形名大小写不敏感解析：先内置 id、再导入波形名（写错则该脉冲失败软并记日志 —— 不会拖垮宿主）。GUI 面板会出现自动电击区块：实时布防状态、触发/跳过计数与布防/解除按钮；`coyote_status` 携带同一块给模型。插件卸载时解除布防、截断进行中的脉冲并立即恢复基线。

## 配置项

全部可选，默认值如下：

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `0.0.0.0` | 监听地址。`0.0.0.0` 让局域网手机可达。 |
| `port` | `9999` | WebSocket 端口。`0` 表示系统分配。 |
| `publicWsUrl` | — | `wss://` 反向代理场景的二维码地址前缀。 |
| `waveformDir` | `coyote-waveforms` | 社区波形持久化目录。 |
| `softLimitA` / `softLimitB` | `100` | 每通道软上限，0..200。 |
| `sessionCooldownSec` | `3` | 重新配对冷却秒数；`0` 关闭。 |
| `maxSessionSec` | `3600` | 单次绑定会话硬上限秒数；`0` 关闭。 |
| `maxPlaySec` | `600` | 单次播放硬上限秒数。 |
| `defaultPlaySec` | `30` | 工具调用未给时长时的默认值。 |
| `increaseRatePerSec` | `40` | 持续升速（单位/秒）。 |
| `increaseBurst` | `40` | 突发上调预算（单位）。 |
| `autoStim` | `enabled: false` | 整个[自动电击](#自动电击)块：`enabled`、`maxIntensity`（30）、`cooldownSec`（5）、`tickIntervalSec`（5）、`restoreBaseline`（true）与逐 `events` 规则覆盖。 |

## 架构

```
src/
  protocol/   纯 V3 编解码：帧、波形条目、二维码
  waveform/   合成器（规格→窗口）、库（12 预设）、导入器、调度器
  transport/  WebSocket 服务 + 控制终端角色（绑定、心跳、失败安全）
  runtime/    一切都经过的安全边界
  auto-stim/  rules（事件表+默认值+校验）、mapper（宿主→领域事件）、engine（闸门+脉冲）、attach（cordis 监听）
  gui/        /gui 桥：JSON 操作 ↔ runtime，广播状态
  tools/      8 个 coyote_* 工具定义
client/index.js   浏览器面板（无构建步骤、加载器注入 React、DSH CSS 变量）
tests/            148 个测试：单元 + 协议级 MockApp + 离线客户端 harness
```

设计准则：协议层纯函数、安全单一咽喉点、工具薄而诚实、不过度设计。所有协议决策的依据均为官方 [DG-LAB-OPENSOURCE](https://github.com/ZGQ-inc/DG-LAB-OPENSOURCE) socket/V3 文档。

## 开发

```bash
pnpm install
pnpm test         # 148 个测试
pnpm typecheck
pnpm build        # 产出 lib/（tsdown）
```

说明：`pnpm build` 会打印一条 tsdown↔rolldown 上游校验告警（`Invalid input options … "define"`），属上游噪音，产物正确。

## 安全须知

本插件驱动作用于人体的真实电刺激设备。请遵循设备随附的 DG-LAB 安全指引。要点：

- 从个位数强度起步、缓慢上调；开始前与使用者约定上限与停止信号。
- 保留 App 侧硬上限作为最终防线 —— runtime 会动态遵守它。
- 胸部、颈部、头部为不安全电极位置；任何不适或异常反应立即 `coyote_panic_stop`（它绝不会让情况更糟）。
- 仅在知情成年人自愿的前提下使用。

## 许可

[MIT](LICENSE) · 第三方声明见 [NOTICE.md](NOTICE.md)
