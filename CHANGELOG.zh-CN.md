# 更新日志（简体中文）

本项目的所有重要变更都在此记录。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
