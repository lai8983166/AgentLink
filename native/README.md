# AgentLink NSH Android

这是同仓库第二套安卓客户端的**阶段零宿主验证版**，尚未接入 AgentLink 后台。现有 web/ 与 mobile/ 保持独立可用。

当前页面验证 NSH 原生输入、宿主双向消息和 Android Keystore 加密读写，只输入人工测试文字。不是可遥控会话的正式客户端。安装不要求 USB：可以把 APK 传到手机手动安装；ADB（USB 或无线）只用于自动安装和仪器测试。

## 构建

需要 Node 22+、JDK 21、Android SDK 36 / build-tools 36.0.0，以及 Windows x64 或 Linux x64。设置 JAVA_HOME 和 ANDROID_HOME 指向本地工具链。Linux 还需 curl、tar、python3；Windows 需 curl.exe、tar、PowerShell。使用预编译 NSH AAR 时无需安装 Rust/NDK；本阶段 debug 包保留原生符号，包体不代表最终发布大小。

在仓库根目录执行：

```bash
node native/scripts/setup.mjs
node native/scripts/build.mjs test
node native/scripts/build.mjs apk
node native/scripts/build.mjs test-apk
```

setup 下载 toolchain.lock.json 中固定的 NSH 0.4.0 CLI 和 Android 库，验证归档及 AAR SHA-256 后安装到被忽略的 .tools/。可用 NSH_ARCHIVE_DIR 指向已下载的官方归档目录，文件名需与 lock 一致，仍会校验。缓存下载不完整时只需删除对应 .tools/downloads 文件后重试。

debug 产物为 android/app/build/outputs/apk/debug/app-debug.apk，包名 io.agentlink.nsh.debug，可与现有客户端并装。release 发布尚未配置，不能用本验证包代替正式发布。Linux 构建已验证；Windows 入口尚未实测。

## 验证

```bash
# 连接一个已授权的模拟器或 USB/无线设备后运行
node native/scripts/build.mjs connected-test
```

仪器测试仅操作 NSH debug 包及人工文字，验证宿主通信、加密落盘和 Activity 重建。无界面测试中的 host.mjs 是内存假宿主，不证明 Android Keystore 或真机输入法正常。实际结果见 VALIDATION.md。

手工安装后：输入人工文字，依次点击“验证双向通信”“加密保存测试文字”；关闭并重新打开应用，点击“读取测试文字”。另检查中文输入法组合输入、键盘遮挡、返回键、字体缩放及旋转。不要将真实 token、会话正文或本机地址填入此测试页。

## 维护边界

- App.tsx/app/ 是 NSH 界面；android/ 是独立 Kotlin 宿主；scripts/ 负责固定版本构建。
- NSH CLI、AAR 与 bundle 必须匹配。构建校验本地 AAR，Gradle 在缺少 bundle 时拒绝构建。
- 原始日志、截图、APK、下载库和本地 SDK 配置不提交；VALIDATION.md 仅记去身份化结论。
- 后续会话核心、通知及发布工作按 openspec/changes/add-nsh-android-client/tasks.md 推进；阶段零未验收前不把客户端视为可用。

NSH 依赖来源：[官方仓库](https://github.com/longbridge/nsh)、[Android 嵌入文档](https://nsh.dev/docs/android/)，许可 Apache-2.0。发布前需随产物保留依赖许可与所需声明。
