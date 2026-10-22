# AgentLink Android 自用客户端

当前仓库的增量客户端：React 界面内置在 APK，Capacitor 连接 Kotlin 插件；通知由 Kotlin 前台服务接收，不依赖 Google Play 服务、FCM 或网页 Service Worker。浏览器版本继续保留。

## 使用

1. 电脑运行包含安卓通知接口的新版 daemon。下载同一 HTTPS 入口的 `/downloads/agentlink.apk`，允许下载来源安装未知应用。
2. 输入现有 AgentLink **HTTPS 根地址**与配对 token。证书必须有效，不支持忽略证书错误。APK 不包含个人地址、token 或签名私钥。
3. 设置 → 安卓任务通知 → 开启任务通知，允许系统通知权限。
4. 点击后台运行设置，允许省电豁免；在小米系统手动允许自启动、将省电策略设为不限制，并按需要锁定后台。
5. 发测试通知，实际检查通知栏；再测试锁屏、离开界面、切换 Wi-Fi/移动网络及长时间待机。

前台服务会显示持续的连接通知。关闭聊天界面不主动停止服务；手动强制停止应用、系统清理、断网、省电限制仍可能中断通知。重开应用会尝试恢复此前启用的服务。重启手机后请先打开应用，不承诺系统自动启动。电脑必须保持运行和联网。

任务完成/出错通知保存 24 小时，手机读取后展示并确认；确认丢失时通过稳定通知编号及本地记录去重。新设备不接收注册前的任务通知。通知是至少一次传输，无法承诺系统展示与后台确认之间绝对原子。通知权限或任务通知频道关闭时保留队列，不将其误记为送达。

解除配对先停止本机服务、注销设备，再清理 token；离线注销失败会提示重试。token 轮换使旧配对失效，重新配对后需重新开启通知。

## 开发与构建

需要 Node 22+、pnpm、JDK 21、Android SDK 36 / build-tools 36.0.0，以及可下载 Gradle/Maven 依赖的网络。Android 工程位于 `mobile/android`。首次安装依赖后：

```bash
pnpm install
pnpm --filter @agentlink/mobile sync
cd mobile/android
./gradlew :app:assembleDebug :app:testDebugUnitTest
```

Debug 使用独立包名 `io.agentlink.mobile.debug`，release 为 `io.agentlink.mobile`，数据互不共享。Debug 允许模拟器隔离测试使用明文假服务；release 始终禁止明文连接。

首次自用发布先创建并备份专用签名密钥，保存在仓库外：

```bash
keytool -genkeypair -keystore /安全位置/agentlink-release.jks -alias agentlink -keyalg RSA -keysize 3072 -validity 10000
```

在 `mobile/android/keystore.properties` 填写以下配置（已被 Git 忽略；路径使用 `/`，不要把密钥和密码提交）：

```properties
storeFile=/安全位置/agentlink-release.jks
storePassword=本地密钥密码
keyAlias=agentlink
keyPassword=本地密钥密码
```

```bash
pnpm --filter @agentlink/mobile release
```

输出 `mobile/release/AgentLink.apk` 和 SHA-256。daemon 从这个固定文件提供下载，后续使用同一签名并递增 `versionCode` 覆盖升级。没有配置签名时发布脚本明确失败，不以 debug 包替代。保留密钥及配置，否则后续覆盖升级可能失败。

## 测试

- 后台：`bun test daemon shared`，覆盖注册认证、设备隔离、读取不删除、确认幂等、断线/重启补收、24 小时过期和原 Web Push 回归。
- 网页：`pnpm --filter @agentlink/web test`，包含安卓地址限制、通知内部路径、原生通知设置。
- Kotlin：`:app:testDebugUnitTest` 验证服务器/通知地址边界和退避策略。
- Android 14 AOSP 无 Google 服务模拟器：运行 `bun mobile/test-fixture.ts`，再执行：

```bash
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.fixtureUrl=http://10.0.2.2:48918
```

该仪器测试仅操作独立 debug 包与内存假服务，不连接真实 Codex、不执行真实指令、不发送外部 Web Push。模拟器验证不能替代小米真机的锁屏和待机验收。

## 接口与实现边界

`POST /api/v1/native-push/devices` 注册安装编号；`GET .../:id/inbox` 最长 20 秒长轮询；`POST .../:id/ack` 展示后确认；`POST .../:id/test` 测试；`DELETE .../:id` 注销。全部要求 Bearer 配对认证，并设置 no-store。安卓通知共享已有持久化完成事件，独立于网页会话订阅；不改变 Codex 会话占用、接管或审批逻辑。

Kotlin 服务使用明确声明用途的 `specialUse` 前台服务类型，不能通过 `dataSync` 无限运行规避 Android 新版限制。当前为自用版本，未来公开上架需要另行核对商店权限和前台服务审核要求。

内置网页来源固定为 `https://localhost`，daemon 仅增加这一来源的 CORS 支持；所有控制接口继续验证 token。原生凭据由 Android Keystore 加密保存，系统备份关闭。WebView 配对态仍保存在应用沙箱中的网页存储；不将 token 放入通知或深链接。
