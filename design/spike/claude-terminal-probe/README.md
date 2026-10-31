# Claude 原终端会话验证

这是独立验证工具，不是已接入 AgentLink 的正式 Claude 适配器。不会自动安装插件、修改 Claude 用户设置或连接其他会话。仅当启动进程显式设置 `AGENTLINK_CLAUDE_PROBE_URL` 和 `AGENTLINK_CLAUDE_PROBE_TOKEN` 时启用；地址只能是 `http://127.0.0.1:<port>`。

目标：验证同一个 Claude CLI 进程、同一个 session ID 下的消息发送、文本流、审批、停止和断线恢复。验证期间只使用专用测试目录与测试会话。

插件基于 Claude Code mod API，初始验证版本为 Windows CLI 2.1.314。旧版 WSL CLI 2.1.23 不支持此路径。

## 独立校验

```sh
claude plugin validate --strict ./design/spike/claude-terminal-probe/plugin
claude plugin test ./design/spike/claude-terminal-probe/plugin
```

官方测试工具不启动会话、不调用模型，也不执行测试中的工具命令。通过它只能证明接口和事件处理，不能当作真实终端接管已通过。

服务测试不需要 Claude 登录或模型：

```sh
node --test design/spike/claude-terminal-probe/broker.test.mjs
```

## 真实终端验证（不调用远程模型）

在 Windows 原生终端、仓库根目录运行：

```sh
node design/spike/claude-terminal-probe/run-fixture.mjs
```

该命令创建 `.local/run-<时间>/`，以独立 `CLAUDE_CONFIG_DIR`、虚拟 API key、纯本机 Messages 接口和空 MCP 配置启动真正的交互式 Claude 进程。用户的 API key、Claude 设置和现有会话不会传入测试。默认使用 Windows npm 安装的 `claude.exe`；其他安装位置可通过 `AGENTLINK_CLAUDE_BINARY` 指定。请使用已验证的 CLI 2.1.314；不会自动更新 CLI。

首次仅确认信任这个空测试目录，以及使用界面明确显示的 **fixture dummy key**。没有真实密钥需要输入。启动后，在第二个终端用打印的运行目录执行：

```sh
node design/spike/claude-terminal-probe/verify-live.mjs "<运行目录>/broker.json" --restart
```

它只允许驱动有 `run.json` 标记的隔离测试会话，验证交互式 terminal 来源、原 ID、原 PID、发送、流式输出、远程审批、忙碌排队、验证后台重启、停止后再发送和权威历史快照。结果写在运行目录的 `verification.json`。第一终端输入 `/exit` 后，假 API 的工具执行结果汇总写入 `fixture-stats.json`。

要单独观察或操作同一个测试会话：

```sh
node design/spike/claude-terminal-probe/control.mjs "<运行目录>/broker.json" list
node design/spike/claude-terminal-probe/control.mjs "<运行目录>/broker.json" events <会话ID>
node design/spike/claude-terminal-probe/control.mjs "<运行目录>/broker.json" send <会话ID> PROBE:READY
node design/spike/claude-terminal-probe/control.mjs "<运行目录>/broker.json" snapshot <会话ID>
```

手工补测：在第一终端输入 `PROBE:APPROVAL`，在原生对话框选择一次性 Yes，然后从第二终端对旧 approval ID 提交决定，应返回 409。在第一终端输入 `PROBE:LONG`，按 Esc，然后从验证工具发送新消息，应记录明确的 `rejected`；在第一终端输入 `PROBE:READY` 后，后续插件消息恢复可用。不要选持久允许或切换自动权限模式，避免改变后续测试条件。

`broker.json` 包含测试凭据和测试历史，只供本机控制工具读取，不分享、不入库。服务只监听回环地址，不直接提供手机入口，也没有接入生产 AgentLink 后台。

## 约束

- 只加载插件而未配置验证连接时，插件不连接后台。
- 消息提交等候 Claude 空闲；区分已排队、已开始和被拒绝，不自动重发未知结果。
- 中止操作必须携带当前 turn ID，旧按钮不能停止后一轮。
- 默认只观察审批；显式设置 `AGENTLINK_CLAUDE_PROBE_APPROVALS=1` 才转发远程决定。
- 验证服务不可达时不改变 Claude 的原生权限规则，也不关闭 Claude 进程。
- 终端先处理、远程先处理已分别验证；真正同时到达和多工具并发仍需进一步核实。
- 本地验证记录、凭据和 CLI 生成的类型文件不入库。

## 已确认的接口差异

- mod 的 `classic.PermissionRequest` 返回 `{ decision: { behavior: "allow" } }`；普通 shell hook 的 `hookSpecificOutput` 包装会被真实 mod host 忽略。单元测试若写成同样的错误预期，仍可能通过，必须做真实 CLI 验证。
- `classic.PreToolUse` 在 mod 内收到的是平铺的 `ToolCallEnvelope`，不同于 shell stdin JSON。这里用 `tool.check` 的 `input` 和 `tool_use_id` 关联审批，只有唯一匹配才在工具完成时作废对应请求；相同工具的并发请求不能批量作废。
- 终端按 **Esc** 后，插件提交返回 `the session was stopped and nobody has sent input since`。不会假报成功或自动无限重试，需要终端再次输入。通过 `$.turn.abort()` 停止后再发送则已通过。后者还可能不产生 `turn.complete`，所以成功停止后主动清除对应运行状态。
- 插件提交会在 TUI 显示插件来源。即使使用 `asUser: true`，也不应声称与用户在终端亲自输入的来源完全相同。
- 插件从后台提交的消息未必经过自身的 `prompt.submit` 观察 hook，所以排队事件同时携带原文，历史以显式拉取的 `$.session.messages()` 为准。
- 热加载的启动事件不能证明当前空闲，初始状态为 `unknown`，待后续真实轮次事件更新。正在执行中才加载插件时的完整状态重建尚未通过验证。
- AskUserQuestion、计划确认、沙箱网络授权、并发子代理审批和真实外网手机链路不包含在本次通过范围内。

结果及正式适配前的条件见 [验证报告](./VERIFICATION.md)。

参考：[mod API](https://code.claude.com/docs/en/plugins/mods/api)、[事件](https://code.claude.com/docs/en/plugins/mods/events)、[官方测试工具](https://code.claude.com/docs/en/plugins/mods/test)。
