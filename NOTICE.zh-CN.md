# 第三方声明（简体中文）

本项目的代码为独立原创，未引入下列项目的源码，但其公开文档与生态惯例为本项目的互操作与设计决策提供了技术基础。感谢这些项目的作者。

## DG-LAB-OPENSOURCE

- 项目：<https://github.com/ZGQ-inc/DG-LAB-OPENSOURCE>
- 用途：V3 socket 协议（帧结构、绑定/断开/心跳流程、错误码、1950 字符帧上限、100 条脉冲上限）、V3 波形条目编码（8 字节：4 频率 + 4 强度、25ms 窗口、10..240 压缩周期域）以及二维码载荷格式。
- 许可证：请参阅该仓库。

## DG-Lab-Coyote-Game-Hub

- 项目：<https://github.com/SweetSmellFox/DG-Lab-Coyote-Game-Hub>
- 用途：导入器支持的社区波形 `.pulses` 交换格式（`[{ name, pulseData: ["16-hex", …] }]`）。
- 许可证：请参阅该仓库。

## DeepSeek Harness 生态插件

- `dsh-community-hot` 与 `dsh-client-ui-writing` 为本项目采用的客户端插件惯例提供了参考：`window.__ModuleLoader__.load({ id, factory })` 交接、受保护的测试钩子、`dsh.client` 清单（`platform`、`inject`）、通过 `ctx.slots.inject` / `ctx.slots.register` 的插槽注册，以及用于主题化的 DSH CSS 别名变量。
- 仅作参考，未复制任何源码。

## 运行时依赖

- [`ws`](https://github.com/websockets/ws)（MIT）——WebSocket 服务端与测试客户端。
- [`qrcode`](https://github.com/soldair/node-qrcode)（MIT）——二维码 data-URL 渲染。

对等依赖（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）由 DeepSeek Harness 宿主在运行时提供。
