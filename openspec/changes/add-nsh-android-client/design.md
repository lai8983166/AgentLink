## Context

动机见 proposal.md。当前 daemon 集中管理会话归属与代理桥接；web 使用 REST、单连接 WebSocket、HistoryReader 和消息回执；mobile 使用 Capacitor 界面及 Kotlin 前台通知服务。shared 是 Zod/TypeScript 契约，不是独立于运行环境的 SDK。

已检查 README、mobile/README.md、web/src/api/client.ts、history-reader.ts、message-outbox.ts、shared 的 REST/WS/native-push 定义及 Kotlin 插件与通知策略。正式 specs 目录为空，旧变更的 mobile-client 与 desktop-session-takeover delta 仍在进行中；其中自动发送排队消息、拥有者消失回退等早期描述不能直接作为新客户端行为。以当前后台返回的能力、回执和 README 中显式恢复/占用检查为本变更基线，不修改旧 delta。

官方依据（查阅于 2026-11-09）：[NSH Android](https://nsh.dev/docs/android/) 提供 API 28+ 的 Android 视图、可嵌入 Kotlin 宿主的 NshView/AAR、宿主消息桥和 APK 内置 bundle。[平台说明](https://nsh.dev/docs/platforms/) 区分 TSX/QuickJS 与 Rust 应用。文档支持方案选择，不等于本项目已验证兼容性或性能。

## Goals / Non-Goals

**Goals:** 隔离框架变化、保留单一后台规则来源、验证原生 UI 的实际体验，让两套客户端能并装与独立升级。首版能力边界见 proposal 与 spec。

**Non-Goals:** 不把 React hooks/DOM/IndexedDB 搬入 NSH；不强制全面抽取现有前端，不迁移旧 APK 数据，不重新实现 Codex/Claude IPC，不承诺锁屏永久保活。

## Decisions

### D1 同仓库独立客户端与构建入口

新增 native/，建议组织为 app/（NSH TSX 页面）、core/（传输、历史、回执、状态）、android/（Kotlin 宿主）、tests/、scripts/、README.md、VALIDATION.md。NSH 配置位于 native/，Android 使用独立 Gradle 项目。与现有 pnpm 构建通过显式脚本集成，不让普通 web 开发强制安装 Android 工具链。

release 包名采用 io.agentlink.nsh，debug 为 io.agentlink.nsh.debug，名称包含 NSH；独立版本号、签名配置、存储与安装设备 UUID。相较分仓库，此方案可在一次变更内对齐协议与客户端；相较长期分支，可保留可同时构建的两个产品。

### D2 NSH TSX + Kotlin 宿主

采用 APK 内置 NSH TSX bundle，通过 Kotlin Activity 嵌入 NshView；界面使用 NSH 原生组件，不加载现有 React 网页。Kotlin 处理 Keystore、通知服务、系统权限、生命周期与通知导航，使用明确命名且校验参数的 host.call/host.on 边界。网络与 UI 解耦；核心层首选 NSH 网络 API，若目标版本的证书/WS行为不满足契约，仅替换传输适配层为 Kotlin，不修改后台协议。

选择 TSX 是为了复用团队 TypeScript 经验和纯业务算法；纯 Rust 全量客户端会增加首版迁移成本，标准 NSH 打包宿主则不利于复用现有通知服务。采用自有 Gradle 宿主，因此不把 nsh package 默认打包流程当作正式发布流程。release 使用 release AAR 和内置资源，关闭开发服务器与远程代码更新；NSH CLI/AAR/bundle 固定同一经过验证的版本与校验值，优先验证官方发布版，必要源码构建也固定 commit。

### D3 阶段零与延期设备验收

2026-11-09 用户明确调整：继续实现全部客户端功能，最终交付 APK 手动验收。真机/模拟器不可用不再阻塞后续阶段，未执行项保留待验收；可自动执行的构建、契约和逻辑测试仍必须完成。下文的准入要求用于最终验收，不作为等待设备期间的开发门槛。

先制作最小 Android debug 宿主：输入/安全区/返回键、host 双向通信、Keystore 重开读取、HTTPS 与 WS 假服务、原生通知点击。验证 arm64 真机与 x86_64 模拟器；minSdk 28，compile/target SDK 以当前 mobile 的 36 为集成起点，记录实际兼容的 JDK/NDK/Gradle/NSH 组合。

用人工构造的 500 项混合历史、单条 256 KiB 文本和每秒 20 个增量事件连续运行 5 分钟；记录首屏耗时、帧耗时、峰值内存、包体积，与旧客户端同设备同数据比较。准入要求无崩溃/ANR、输入不丢字、历史无缺失/重复、上滑不被新输出拉回。性能指标如实记录，不引用框架宣传值代替验收；若宿主/网络/基本交互无法通过，保留验证结果并修正实现；未执行的设备验收按用户要求延期，不阻塞功能开发。

### D4 协议一致性优先，少量共享代码

shared/src 为线协议参考。新增人工构造的 JSON 契约样例，由现有 Zod schema 验证，再交给 native 解码/状态测试；不假定 Zod 或 npm 模块可直接在 NSH 运行。纯 TS 类型导入不引入运行时依赖，解析未知字段允许向前兼容，关键未知能力禁止控制并提示。

配对身份使用服务根地址和本地身份代号隔离缓存/草稿/回执，禁止将 token 写入文件名。HTTP 使用 Bearer，WS 保持现有认证格式但日志屏蔽含 token 的 URL。凭据通过 Keystore 加密落盘，必要时只在内存交给传输层；release 只允许有效证书 HTTPS 根地址，不跟随携带认证的跨源重定向。debug 明文只允许隔离假服务。

历史同步按 history=window、revision、before、historySync.order、baseRevision 处理；HTTP 基准与 WS 展示缓存分开。epoch 变化、缺口、snapshot.required 或 patch 基准不匹配时只读重建。缓存上限沿用最多 8 个会话、估算 8 MiB，超限使用内存/联网读取；缓存核对前不开放控制。旧完整详情兼容保留，核心字段缺失须显示版本不兼容。

消息出站持久化 clientMessageId 与 draft/sending/queued/accepted/failed/uncertain 状态；恢复时 sending 进入 uncertain，查询回执/历史，绝不因断网自动重发。queued 仅表示后台确实返回排队回执；晚到回执不能清空新草稿。其他写操作超时也先读取状态，避免重复创建/审批/接管。

### D5 页面和会话控制

配对 → 首页 → 最近/全部目录 → 会话详情；设置包含连接、通知、版本和解除配对。最近列表采用现有 30 天规则，全部目录按代理区分并支持标题/项目搜索，每批展示 50 项。会话详情支持 Markdown 基础格式、可复制代码块、工具摘要/展开、差异内容、状态与审批卡片；不执行消息内 HTML/脚本。

进入会话仅浏览/观察；恢复、接管、fork、新建、策略修改均为用户显式动作，并基于最新状态开放。Claude 未连接时只读，问答/计划确认等未支持交互提示回原终端；不把所有 Codex 操作强加给 Claude。NSH 客户端不连接本地代理、不推断锁已释放。

新建任务使用现有 fs 与 sessions 接口，展示后台允许的项目路径和审批策略；本次不新增 Claude 会话创建。长列表采用 NSH 列表组件与稳定 key，增量批处理、按需展开大文本；向上翻页保持锚点，中文输入法、系统字号、安全区与返回键纳入真机验收。

### D6 通知复用与边界

沿用 devices/inbox/ack/test/delete 协议及至少一次语义，不用 FCM。实施时将现有 Kotlin 中不依赖 Capacitor 的通知策略、API、凭据与投递逻辑提取到独立 Android library（建议 mobile/android/native-core），由两宿主引用；Activity/Capacitor 包装、导航入口和资源通过宿主适配，避免复制两份长期分叉。先以原客户端测试证明提取等价，再接入 NSH。

设备 UUID、通知去重记录、channel 与 PendingIntent 都按安装包隔离。用户明确开启后启动当前同类前台服务；通知权限关闭时不 ack，显示后确认，重投按稳定 ID 去重。点击通知只接受内部会话路径并在当前配对身份下查询，不携带 token、不触发控制。解除配对先停本机服务再注销；离线失败明确提示并保留加密的注销重试上下文，不继续收取。手机重启后需手动打开，系统强停/省电限制不承诺自动恢复。

### D7 双实现维护与交付

建立功能对照表：核心会话行为必须同时验收；首版暂缓审计浏览、额度面板、PWA 更新等辅助功能并明确标记。共享契约变更必须更新两套解析测试和功能对照；平台体验可独立演进。CI 分开检查 web/daemon 与 native，协议或共享 Kotlin 修改触发双方检查。

独立签名 APK 输出 native/release/AgentLink-NSH.apk 与 SHA-256，通过文件交付/手动安装；本变更不新增 daemon 下载路由，不覆盖 mobile/release/AgentLink.apk。签名材料在仓库外，缺失时 release 明确失败。所有文档、测试和可提交验收记录只使用人工样例及去身份化指标。

## Risks / Trade-offs

- [NSH API 和 Android 宿主兼容性尚未实测] → 版本锁定、构建和假服务测试先行，设备验证延期但如实记录。
- [动态长文本、Markdown 和输入法表现] → 混合历史压力场景、稳定列表 key、按需展开与真机验证。
- [共享 Kotlin 提取影响旧 APK] → 独立小提交、旧单元/仪器测试和并装回归；禁止顺带修改旧包名和下载路径。
- [后台通知受系统限制] → 复用现有服务语义与设置引导，报告真实待机结果，不宣称绝对送达。
- [旧 delta 与当前实现不完全一致] → 本规格明确当前客户端边界，后续主规格归档单独协调。
- [双实现维护成本] → 契约样例和核心行为矩阵共享，界面各自测试；首版不追求辅助功能完全一致。

## Migration Plan

1. 验证最小宿主并记录通过/失败结论；并行推进协议核心和基本页面，设备验收按用户要求延期。
2. 增量补齐会话控制，提取并接入通知模块；每个独立验证阶段做本地提交。
3. 运行假服务与回归检查，再在可用真机上验收；未执行的真机项目不得写成通过。
4. 输出独立签名 APK，与旧版并装试用。回退只需停用/卸载 NSH 客户端，旧客户端与后台继续工作；共享 Kotlin 提取可单独回退。

## 实施结果（2026-11-09）

采用 Kotlin OkHttp 传输，认证凭据留在宿主；shared Zod 可由固定 NSH 0.4.0 成功打包并通过无界面测试，故直接复用解析器。共享 Kotlin 模块、纯历史 reducer、会话状态及 WS 管理器已复用；核心 UI、缓存/回执和签名 APK 已实现。实际证据和待验边界见 native/VALIDATION.md，辅助功能差异见 native/COMPATIBILITY.md。
