# AgentLink · Claude Code

连接你正在使用的 Claude Code **原终端进程与原会话**。手机页面或 APK 关闭不会停止任务，不会自动恢复或 fork 出第二个进程。当前要求 Claude Code 2.1.314 或更新版本；不更新你的 CLI，不改变终端权限或模型配置。

## 安装

启动新版 AgentLink 后台，在仓库根目录执行：

```sh
node plugins/install.mjs
# 或 bun run daemon/src/cli.ts claude install
```

该命令通过 Claude 官方 plugin 命令将本仓库 `plugins/` 注册为本地 marketplace，安装 `agentlink@agentlink-local` 到用户范围。不会向其他终端发送任务。之后在项目中照常执行 `claude`，手机的会话列表出现 **CLAUDE** 标识。

已经打开的 Claude 会话中，输入 `/reload-plugins` 加载插件；`/agentlink` 查看原会话 ID。热加载到正在执行中的会话时，暂时显示状态待确认，后续真实轮次事件会更新状态。只有观察到当前 turn ID 后才开放停止按钮。

仅对某个终端试用而不安装：

```sh
claude --plugin-dir "<AgentLink 仓库>/plugins/claude-code"
```

更新插件代码后执行 `claude plugin update agentlink@agentlink-local`，再在原终端 `/reload-plugins`。停用用 `claude plugin disable agentlink@agentlink-local`；不需要更换登录或手机配对。

## 使用

- 同一列表可查看 Codex 和 Claude，Claude 不走 Codex 的 observe/resume/fork。
- 原终端与手机发出的消息、输出和工具记录同步。历史快照保留最近 200 条模型消息，实时历史最多 500 条展示项。
- 排队仅表示后台保存了指令，终端实际开始后才显示接收确认；重连核对结果，不自动重复发送。
- 手机只对 Claude 原本要求的工具授权提供一次性批准/拒绝；自动允许的工具不会被额外要求审批。终端已经处理的请求会作废。完全访问仍服从 Claude 自身的特殊限制。
- 完成/错误接入已有安卓通知与 Web Push，跟任务从手机还是电脑发起无关。需先在手机开启任务通知，后台及终端持续运行。
- 电脑终端按 **Esc** 后，Claude 会拒绝插件输入，需在电脑亲自发送一条消息解除。手机的停止接口与该原生 Esc 路径不同，停止后可以继续从手机发送。
- AskUserQuestion、计划确认、沙箱网络提示及无法唯一关联的并发审批保留原生终端处理，不伪装成普通工具批准。

## 连接与数据

后台另开 `127.0.0.1` 随机端口，通过用户目录 `~/.agentlink/claude-bridge.json` 让插件发现地址。凭据与手机配对 token 分开，不经过公网路由；文件不要分享或提交。后台换端口后插件重新读取该文件。自定义后台配置目录可在终端设置 `AGENTLINK_CLAUDE_BRIDGE_FILE` 指向连接文件。

会话只允许来自后台配置的项目根目录白名单。离线时显示未连接，不将运行状态猜成空闲。后台用 `claude.db` 保存历史和回执；原进程仍拥有所有实际执行。插件实例更换后未确认指令不会自动重放。

## 验证

```sh
claude plugin validate --strict ./plugins/claude-code
claude plugin test ./plugins/claude-code
bun test daemon/src/claude
```

真实终端的早期接口验证见 `design/spike/claude-terminal-probe/VERIFICATION.md`；正式集成另由隔离浏览器与 CLI fixture 验证。测试不向真实用户会话发送消息或审批。
