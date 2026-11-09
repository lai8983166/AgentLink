# 双客户端维护对照

旧客户端指 web/ 与 Capacitor mobile/；新客户端指 native/。以下“实现”表示代码已加入，设备是否通过单列于 VALIDATION.md。

| 能力 | 共同语义 | NSH 当前状态 |
| --- | --- | --- |
| 配对 | HTTPS 根地址、Bearer、身份隔离 | 已实现；Kotlin Keystore，凭据不进入 TS |
| 目录 | 30 天最近、按代理全部、搜索；浏览不恢复/fork | 已实现；每批 50 项原生 List |
| 历史 | window/revision/before、replace/patch、顺序与 epoch 校验 | 已实现；最多 8 会话，磁盘估算 8 MiB，超大条目仅内存 |
| WS | 单连接、补订阅、去重、退避、缺口重建 | 复用同一 WsClient；Android 传输实机待验 |
| 离线 | 可读缓存，核对前不可控制 | 已实现；不缓存 token 到历史 |
| 发送 | 持久 clientMessageId、未知不重发、queued 不当作 accepted | 已实现并有响应丢失/重启/晚回执测试 |
| 接管/恢复/中断 | 用户显式操作，后台判定能力与占用 | 已实现；未知状态/Claude 断连拒绝控制 |
| 审批 | 动态 allowed decisions，竞争/过期以后台为准 | 已实现；空/未知决定不给按钮 |
| 新建/fork | 仅 Codex，新 ID 由后台创建，超时不自动重试 | 已实现；项目路径由 fs 白名单控制 |
| Claude | 原终端目录、发送/审批/受限中断 | 已实现；问答/计划确认回电脑处理，不提供 Codex 恢复入口 |
| 通知 | 独立设备，显示后 ack、重投去重、无 FCM | 共用 Kotlin 服务；Android 仪器和待机仍待验 |
| 解除配对 | 先停本机，注销失败保留重试上下文 | 已实现；待验离线与旧通知点击 |
| 内容展示 | 消息/工具/审批、代码复制、不执行 HTML | 原生基础标题/列表/引用/代码；不等同完整网页 Markdown，工具输出及 diff 统计可展开 |
| 审计/额度/PWA 更新 | 辅助功能 | NSH 本版暂缓；使用原客户端 |

人工场景：native/tests/fixtures.ts 和 client.test.ts 使用 shared Zod 解析；NSH client-host.mjs 驱动配对、目录、消息与设置交互；旧侧 web 的 WS、session-state、history-reader、message-outbox 单元测试和 e2e 覆盖相同协议语义。所有样例为合成数据。新增枚举或字段时同步这些测试，不把未知能力推断为可写。

共同边界：不修改 daemon 的代理控制规则；不因进入页面自动创建/接力会话；超时写操作须读取核对，不能盲目重发。两客户端同时操作和同设备通知/性能对照尚未实测，不能用代码共用代替设备证据。
