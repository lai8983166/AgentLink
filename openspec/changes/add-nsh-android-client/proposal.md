## Why

在保留现有 React/Capacitor 客户端的同时，验证 NSH 原生界面对 Android 长会话、输入和流式展示的适用性，并建立同仓库长期维护两套客户端的基础。新客户端复用现有 daemon，避免重复实现会话归属、代理桥接和审批规则。

## What Changes

- 新增 `native/` 下的 NSH Android 客户端，采用 NSH TSX 界面与 Kotlin Android 宿主；先验证宿主嵌入、网络、键盘及长列表，再推进完整客户端。
- 实现 HTTPS 配对、最近/全部 Codex 与 Claude 会话、历史分页、流式输出、显式接管/继续原会话、消息回执、审批和中断。
- 提供新建 Codex 任务、项目目录选择、审批策略和显式 fork；不把连接失败转换为自动恢复或 fork。
- 接入现有 native-push 通知协议，提供无 Google 服务依赖的后台通知、设置与安全凭据存储。
- 新旧 APK 独立包名、设备编号、数据与发布产物，可并装；新增共享协议样例、行为对照及回归验收流程。
- 首版交付安卓自用版本；不开发 iOS/桌面/Web NSH 版、不重写后台、不替代现有客户端、不提供远程 TSX 热更新或应用商店发布。包含审计浏览与额度展示；浏览器专属 PWA 功能不照搬，平台差异明确记录。

## Capabilities

后续范围调整：用户要求按原版还原界面与操作流程，本次纳入原先暂缓的额度展示与审计浏览；原生平台使用 APK 更新与系统通知设置，不模拟网页 PWA 生命周期。

### New Capabilities

- `nsh-android-client`: 独立安卓客户端的配对、会话浏览与控制、历史和消息一致性、原生通知、并装发布及双实现验收。

### Modified Capabilities

无。主规格目录尚未归档现有能力；本变更新增客户端行为规格，不改写其他进行中变更，也不修改 daemon 协议语义。

## Impact

- 新增 `native/` 的 NSH 项目、Android 宿主、测试和构建说明；涉及 NSH/Rust 构建链、Android SDK/NDK/JDK 与 Gradle，实施时固定验证过的版本。
- 复用 `shared/src/{domain,rest,events,ws,native-push}.ts` 协议；纯逻辑通过契约样例对齐，不假设 NSH 可运行 React、浏览器存储或全部 npm 包。
- 参考 `web/src/api/`、历史/消息模块与 `mobile/android` Kotlin 通知实现；共享 Kotlin 代码仅在不依赖 Capacitor 的边界提取，并回归旧 APK。
- daemon 默认无需修改；如发现协议缺口，先记录并单独提出兼容扩展，不为新客户端修改占用与审批规则。
- 增加双客户端验证与独立产物发布说明，现有下载入口和发布流程保持兼容。
