# 测试与可靠性验收

## 日常检查

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

`pnpm check` 依次检查全部 TypeScript 项目、运行后端/共享契约与前端测试、构建 PWA，再运行浏览器测试。单独运行浏览器测试前需执行 `pnpm --filter @agentlink/web build`；配置见 `playwright.config.ts`。配置方式参考 [Playwright Web Server](https://playwright.dev/docs/test-webserver)。

GitHub Actions 在 Windows 上对 push 和 pull request 执行相同检查，并验证 PowerShell 重启脚本语法。浏览器失败时上传截图、trace 和 HTML 报告。配置完成不代表已经在远端执行；本地提交推送后才会触发。

## 覆盖范围

2026-10-09 本地结果：后端/共享包 141 项通过，2 项真实连接测试默认跳过（另行连接本机真实桌面运行，两项均通过）；前端 47 项通过；浏览器 6 项通过。未测量覆盖率百分比。

| 层级 | 重点验证 |
| --- | --- |
| 后端与契约 | 审批等待桌面回执、失败保留待审批、按会话去重、文件审批通道、旧连接隔离、握手失败重试、消息 ID 幂等、重启后未确认结果、接管恢复、事件 epoch 与重订阅、安全重启阻止活动操作 |
| 前端 | HTTP/WS 竞争、首次快照、前台恢复、旧 socket、审批快照恢复、草稿/发送意图保存、超时与发送结果核对、快照失败重试和迟到快照隔离 |
| 浏览器 | Chromium 桌面与 Pixel 7 尺寸各运行三条完整流程：审批恢复/失败重试/文件审批；发送成功但 HTTP 回执丢失、页面重开与同文本新指令；离线与后台重启后接管、草稿、实时状态恢复 |

浏览器使用真实生产构建、真实 Bun/Hono REST/WS、独立端口 `127.0.0.1:48917` 和临时 SQLite 数据库。Codex 与桌面 IPC 使用模拟实现，不连接用户会话、不审批真实请求、不创建或中断真实任务；端口已占用时拒绝复用。临时测试库保留在系统临时目录，失败时可与 trace 一起排查。

## 真实桌面兼容性（只读，可选）

```bash
AGENTLINK_SLOW_TESTS=1 AGENTLINK_IPC_TEST_CONV=<电脑端实际打开的会话ID> bun test daemon/src/codex/slow.test.ts daemon/src/ipc/slow.test.ts
```

检查官方 IPC 握手、真实 owner、快照字段，以及 app-server 初始化、会话列表和既有历史。未找到 owner 或拿不到快照必须失败，不能当作跳过后通过。不会发送消息、审批、恢复或中断会话。桌面/IDE 升级后应重新运行。不同桌面版本的私有 IPC 兼容性仍需持续验证。

## 真机及持续运行验收（未由自动化替代）

- 手机首次打开正在运行的原会话，状态与电脑一致，线程 ID 不变。
- 锁屏/后台 30 分钟后返回；Wi-Fi 与蜂窝网络切换后，恢复状态、审批和草稿。
- 手机上批准、电脑上批准、同时点击及审批失败，结果与实际执行一致。
- 使用专门测试会话验证 Full Access 继承；已有旧轮次的权限不应被误认为已热切换。
- 长时间运行期间关闭或重启桌面应用，界面准确显示失联；重新打开原会话后恢复。
- 释放手机观察/接管不导致任务中断；需要中断时由明确按钮触发。
- AgentLink 持有活动任务或写入锁时，安全重启脚本应拒绝执行。

实体手机验收和长时间运行尚未全部完成，不能据当前测试宣称所有场景已经可靠。

## 安全重启

```powershell
# 只检查，不停止进程
powershell -NoProfile -File scripts/restart-daemon.ps1
# 检查通过后执行
powershell -NoProfile -File scripts/restart-daemon.ps1 -Execute
```

脚本先检查后台活动任务和发送操作，执行时禁止新任务进入，再用 Windows Restart Manager 检查实际会话写入锁。仅停止经验证的 AgentLink 进程树；无法确认、持有锁或仍有任务时拒绝重启。不要把首页“空闲”作为重启依据。旧版本不支持检查接口时脚本会拒绝，首次升级需单独核验实际锁与进程身份。
