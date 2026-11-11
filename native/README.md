# AgentLink NSH Android

同仓库第二套安卓客户端，复用现有 AgentLink 后台。支持 HTTPS 配对、最近/全部 Codex 与 Claude 目录、搜索、历史流与翻页、草稿与回执、发送/中断、显式恢复/接管/fork、动态审批、项目目录与新建 Codex 任务，以及原生任务通知。已提供审计和额度面板，详见 [功能对照](COMPATIBILITY.md)。

当前为 **0.1.6 手机试用版**：默认使用与原版同步的朋克拼贴主题，旧样式保留在构建配置中，应用内没有切换入口，见 [主题维护](../design/ui-themes.md)。构建和自动测试通过不代表真机验收通过。[验证记录](VALIDATION.md) 明确列出未验证项。可以直接将 APK 传到手机安装，**无需 USB**。

后台网页“设置 → 安卓客户端下载”提供原版与 NSH 测试版独立下载；也可打开同一后台地址的 `/downloads/` 选择版本。NSH 文件地址为 `/downloads/agentlink-nsh.apk`，原版 `/downloads/agentlink.apk` 保持不变。后台需运行包含该路由的版本，并已生成相应 release APK。

界面逐页对照与剩余设备验证见 [视觉对照清单](VISUAL_PARITY.md)。

## 安装和使用

1. 将 native/release/AgentLink-NSH.apk 传到 Android 9 或更高版本的手机，允许文件来源安装应用。发布包支持 arm64-v8a，不支持 x86 或仅 32 位的设备；模拟器可使用保留 x86_64 的 debug 包。
2. 打开“AgentLink NSH”，填入与原客户端相同的 HTTPS 根地址和配对 token，例如 https://agent.example.com。必须使用有效证书，不接受 HTTP 或带路径的地址。
3. 打开会话只浏览；需要控制时显式选择接管/继续。发送结果待确认时使用“核对发送结果”，不要把相同指令作为新消息再次发送。
4. 在“设置”开启任务通知，允许系统通知权限，并按手机系统允许后台运行。首次权限授权后可能需要再点一次开启。

release 包名为 io.agentlink.nsh，debug 为 io.agentlink.nsh.debug，与原 io.agentlink.mobile 独立并装。配对、设备 UUID、草稿、缓存、通知与解除配对均各自独立，不迁移原 APK 数据。同一 NSH 包覆盖升级需要相同签名。回退可在设置里解除 NSH 配对后卸载，继续使用原客户端。

通知复用原生长轮询服务，不依赖 Google 服务。强制停止、系统省电、断网可能中断通知；重启手机后需先打开应用。解除配对先停本机服务，远程注销失败时保留加密凭据用于重试，并明确显示待注销状态。

## 构建和检查

需要 Node 22+、Bun 1.4.0、pnpm 10.4.0、JDK 21、Android SDK 36 / build-tools 36.0.0、NDK 28.2.13676358，以及 Windows x64 或 Linux x64。设置 JAVA_HOME、ANDROID_HOME。Linux 需 curl、tar、python3；Windows 需 curl.exe、tar、PowerShell。先在根目录安装工作区依赖。

```bash
pnpm install --frozen-lockfile
node native/scripts/setup.mjs
sdkmanager "ndk;28.2.13676358"
node native/scripts/build.mjs test
node native/scripts/build.mjs unit
node native/scripts/build.mjs apk
node native/scripts/build.mjs test-apk
```

test 包含类型检查、工具链完整性、客户端核心契约/状态与 NSH 无界面交互测试；unit 为 Kotlin JVM 测试。普通 pnpm check 保持无需 Android SDK。独立 CI 在 native/shared/共享 Kotlin/共享状态代码变化时检查两套客户端。

setup 下载 toolchain.lock.json 固定的 NSH 0.4.0 CLI/AAR，并校验 SHA-256。可用 NSH_ARCHIVE_DIR 指向官方归档目录。使用预编译 AAR 无需 Rust；固定 NDK 用于剥离原生符号，Gradle 配置必须与 lock 一致。发布包仅保留 arm64、压缩 SO/DEX 并移除源码映射，目前约 18 MiB。压缩降低下载大小，安装时原生库会解压，不能据此推断运行内存或安装空间同幅下降。Linux 构建已验证；Windows 构建入口尚未实测。

debug 输出 android/app/build/outputs/apk/debug/app-debug.apk。release 需要外部签名配置，缺失时明确失败：

```properties
# 保存在仓库外；storeFile 指向外部绝对路径
storeFile=/private/signing/agentlink.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=YOUR_KEY_ALIAS
keyPassword=YOUR_KEY_PASSWORD
```

```bash
export AGENTLINK_SIGNING_PROPERTIES=/private/signing/keystore.properties
node native/scripts/release.mjs
```

生成 native/release/AgentLink-NSH.apk 和 .apk.sha256，不覆盖旧 mobile/release/AgentLink.apk。本地也可用忽略的 native/android/keystore.properties 保存配置；密钥必须在仓库外。使用现有私有签名配置不改变独立包名/存储。

## 设备验收

连接可用模拟器或已授权的 USB/无线设备后可执行 node native/scripts/build.mjs connected-test。仪器测试使用 debug 专属 probe 页面，验证宿主事件、Keystore 保存/读取和 Activity 重建。无界面测试的假宿主不证明原生输入法和 Keystore 正常。

手机手测清单见 [VALIDATION.md](VALIDATION.md)，不要求自动化或 USB。通知、中文输入、长历史与并装隔离仍需设备确认。不要把真实 token、会话正文、截图或原始日志提交到仓库。

## 维护

- app/ 是 NSH 界面，core/ 管理状态和回执，android/ 提供网络、Keystore 与系统能力，scripts/ 固定构建版本。
- 共用 shared Zod 契约、纯历史 reducer、web 的纯会话状态/WS 管理器，以及 mobile/android/native-core。无 DOM、React 或网页嵌入依赖。网络走 Kotlin OkHttp，token 不传入 TS 状态。
- 改协议或共享逻辑时同步运行两侧测试并更新功能对照。每个验证完成的小部分提交前运行隐私扫描。APK、密钥、SDK 路径和运行日志不入库。
- NSH 依赖来源：[官方仓库](https://github.com/longbridge/nsh)，许可 Apache-2.0。发布时保留依赖声明。

0.1.1 将本机配对状态在界面加载前传入，区分恢复中/读取失败/未配对，并提供重试恢复。界面使用原版米白、黄色及描边风格，但尚未完成逐屏一致性验收。更新请覆盖安装，不要先卸载或清除数据；真机反馈的重开配对问题仍需用户复验。

打包选项依据：[Android JNI 压缩](https://developer.android.com/reference/tools/gradle-api/8.12/com/android/build/api/variant/JniLibsApkPackaging)、[DEX 压缩](https://developer.android.com/reference/tools/gradle-api/8.8/com/android/build/api/dsl/DexPackaging)。

0.1.2 按原版重建页面结构与操作路径：配对卡片、分组列表与额度、条件控制横幅、对话内审批、消息合并、工具/全屏差异、新任务底部弹层、设置与审计。返回保留目录和搜索；更新入口打开后台双版本下载页。逐屏真机视觉和输入法仍待验收，具体平台差异见 COMPATIBILITY.md。
