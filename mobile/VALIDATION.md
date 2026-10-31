# Android 自用 APK 初版验证（2026-10-22）

## 已通过

- 全部 TypeScript 检查与网页、APK 内置页面构建。
- 后台/共享包：193 项通过，2 项可选真实 Codex 连接测试跳过；没有向真实用户会话发送 prompt、审批、恢复或中断。
- 前端：141 项通过，包含安卓连接地址约束、内部通知路径及原生通知开关。
- 浏览器：64 项通过，2 项仅适用于触摸设备的用例在桌面项目跳过。
- Kotlin：3 项本地单元测试通过。
- release APK 构建及签名校验通过，包名 `io.agentlink.mobile`，版本 `0.1.0` / versionCode `1`，minSdk 26、targetSdk 36。
- APK 中没有当前配对 token、签名 keystore 或 keystore.properties。私钥及其备份配置保存在用户目录 `.agentlink/android-signing/`，没有提交 Git。
- 电脑生产后台经写入锁检查后安全重启；原有桌面/IDE 会话写入进程保留。
- 本机 `/downloads/agentlink.apk` 返回 Android APK 类型，下载内容的 SHA-256 与本地签名包一致；安卓接口未配对返回 401、未知设备返回 404；APK 来源 `https://localhost` 的 CORS 预检通过。
- 发布脚本经过实际运行，先完整复制再替换下载文件，避免更新时下载到部分 APK。

## 未完成的运行验收

Android 14 AOSP、无 Google 服务的隔离模拟器运行在当前 WSL 软件模拟环境。调试 APK 与仪器测试 APK 已成功安装；执行仪器测试时，Android 系统进程因 `Lost network stack` / `DeadSystemException` 崩溃，返回 `INSTRUMENTATION_ABORTED: System has crashed.`。Gradle 仪器测试没有取得通过结果，不能据此声称原生后台通知已经实测送达。

现有仪器测试源码保留，假后台与真实 Codex、生产配对和外部推送服务隔离。之后在有硬件加速的模拟器或隔离安卓测试设备上重跑。

用户小米 Android 14 真机仍需逐项确认：

- APK 安装、HTTPS 地址及 token 配对，聊天和审批界面正常。
- 通知权限允许，后台服务启动，测试通知实际展示。
- 离开聊天界面、锁屏后，任务完成/出错能通知，点击返回原会话。
- Wi-Fi/移动网络切换、断网恢复后的补收和去重。
- 关闭通知、解除配对和配对 token 失效后停止接收。
- 按手机系统允许后台运行后，长时间待机的送达与耗电情况。

目前是可安装的初版测试包，真机后台可靠性尚未验收。

## 2026-10-23：修复下载链接空白

已在真实 Service Worker 控制的桌面/手机尺寸浏览器中复现：旧版导航回退会把 `/downloads/agentlink.apk` 返回为缓存的 HTML，React 无匹配路由后显示空白。新增 `/downloads/`、`/api/` 导航放行规则，并验证旧缓存更新后恢复文件下载、配对保持不变。

类型检查与网页构建通过；新增下载回归及原有缓存更新用例共 10 项通过。公网新浏览器上下文实际下载 `https://agentlink.example/downloads/agentlink.apk` 成功，文件名、3,717,507 字节大小和 SHA-256 与签名 APK 一致；公网 `/sw.js` 已含新的放行规则。本次没有改动 APK、原生服务或电脑会话逻辑，不涉及安卓通知运行验收。

## 2026-10-31：0.2.0 Claude 原终端接入

已构建签名 release APK：包名 `io.agentlink.mobile`，版本 `0.2.0`、versionCode `2`，沿用现有签名，可覆盖安装；minSdk 26、targetSdk 36。SHA-256：`3ca278c411fbb205944190a1b951c696987c677cce87d60b249ea9a65247d8ba`。Kotlin 3 项本地单元测试通过，内置 React 页面包含 Claude 会话列表、聊天、排队回执、工具审批及原终端限制说明。

全量浏览器测试 78 项通过、2 项桌面触摸用例跳过；隔离真实 Windows Claude CLI 与手机尺寸页面验证同进程、同会话发送、审批、停止及继续，审批中和运行中重启后台后恢复。关闭页面后的 Claude 任务完成进入原生通知收件箱，并链接原会话。

上述自动化没有在实体安卓设备上重复锁屏、关闭页面及系统通知展示验收。用户此前已确认旧 APK 测试通知可用；新版 Claude 任务通知仍需在真机确认。Windows 原终端按 Esc 后的输入限制和原生问答限制见插件 README。

部署后本机与公网 `https://agentlink.example/downloads/agentlink.apk` 均返回 200、`application/vnd.android.package-archive`，3,718,703 字节，SHA-256 与上述签名包一致；APK Signature Scheme v2 验证通过。后台已更新至 0.2.0，覆盖安装 APK 后沿用原配对与通知设置。

## 2026-10-31：0.2.1 分页、历史缓存与增量核对

已构建签名 release APK：`io.agentlink.mobile`，版本 `0.2.1`、versionCode `3`，沿用现有签名，minSdk 26、targetSdk 36；APK Signature Scheme v2 验证通过。SHA-256：`7cd1931ad2b11a609ee5c9739ab834758b57dca39e9c31ccd2c2c0bf726a787a`。Kotlin 3 项单元测试通过。内置页面采用最近记录分页、IndexedDB 缓存、按版本核对变化，既有配对、草稿及通知设置继续保留。

本次未改原生通知服务，未重复实体手机系统通知或锁屏验收。页面缓存与滚动行为由真实 Chromium 桌面、手机尺寸测试验证；实体 WebView 的最终体验仍需真机确认。
