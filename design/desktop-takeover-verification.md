# 原会话接管验证（2026-10-06）

## 结论

本机官方桌面端已通过外部客户端对原会话发指令、接收状态更新、审批和中断的验证。没有调用 fork，也没有另一个 app-server 恢复该桌面会话。

这是本机连接层的实测，不代表 AgentLink 手机 PWA、外网通道、断线重连已实现或验收。桌面窗口的视觉渲染未通过截图核验；返回数据来自官方桌面程序所维护的同一会话状态。

## 环境与路径

- Windows；桌面包 `OpenAI.Codex_26.930.4958.0_x64`，内置 `codex-cli 0.160.0`。
- 桌面 app-server 使用 stdio；未发现该进程的 TCP 监听。
- `app-server proxy` 连接默认控制 socket 失败。本版桌面代码中默认共享 daemon 分支排除了 Windows，不能把这条路线视为已验证可用。
- 桌面本地 IPC：`\\.\pipe\codex-ipc`，4 字节小端长度前缀 + JSON。
- 外部客户端初始化后，用 `thread-owner-discovery` 找到原会话拥有者，通过 follower 请求委托它操作原 app-server。
- 此 IPC 是从已安装桌面程序代码核对并实测的内部接口，不是已承诺稳定的公开集成 API，版本升级需兼容性测试。

## 官方桌面原会话实测

用户在桌面端新建“回复 READY”并发送测试消息。测试会话 ID：`01a10ef1-c3d4-7d10-8577-f9989d558ab8`。

| 验证项 | 实际结果 |
| --- | --- |
| 查找拥有者 | `thread-owner-discovery` 返回 success 和拥有者 client ID |
| 读取原会话 | following 广播后收到 `thread-stream-state-changed` snapshot，标题与 READY 内容匹配 |
| 外部发指令 | `thread-follower-start-turn` 返回 success；原会话回复 `AGENTLINK_DESKTOP_TAKEOVER_OK` |
| 状态同步 | 操作过程中收到原会话的 patches 和 snapshot |
| 外部审批 | 收到原会话 `item/commandExecution/requestApproval`，用 `thread-follower-command-approval-decision` 批准，返回 `{ok:true}` |
| 审批后的执行 | 只执行回显命令，状态 completed，输出 `AGENTLINK_DESKTOP_APPROVAL_OK` |
| 外部中断 | `thread-follower-interrupt-turn` 返回正确 interruptedTurnId 和 `{ok:true}`，最终 turn 状态 interrupted |
| 非 fork | 全程原 ID 不变，最终 `forkedFromId:null`，历史包含 READY 和两次测试回复 |
| 权限恢复 | 审批测试单轮使用 untrusted/read-only，最后一轮恢复测试会话原来的 never / :danger-full-access，已读取状态确认 |

测试没有修改目标项目文件。临时完整快照不保留进仓库。

## 共享 app-server 对照试验

独立启动本机 WebSocket app-server，用两个模拟客户端测试：相同 thread ID 下追加指令、两端接收相同文本增量、第二端批准第一端发起的审批、第二端中断且两端收到 interrupted，均通过。这项对照试验本身不等于官方桌面接入；上节 IPC 试验单独完成了官方桌面验证。

空白 thread 在首次 turn 前调用 resume 曾返回 no rollout found；首次 turn 后第二端 resume 成功。中断应等待前一 turn 结束并使用正确活动 turn ID。重复启动端口冲突时应换空闲端口。

## 项目后续实现方向

AgentLink 为桌面拥有的会话增加 IPC follower 适配器：发现拥有者、订阅 snapshot/patches、转发 start/steer/interrupt/审批。保留独立 app-server 适配器处理 AgentLink 自己创建的会话。不要遇到占用就默认 fork。

需补齐并实测：手机 REST/WS 桥接、审批去重、消息幂等、断线后的快照恢复、revision 校验、桌面关闭后的行为、跨网络认证与授权。steer、网络重连、桌面退出后的交接未在本次桌面 IPC 测试中验证。

脚本：`spike/desktop-ipc-probe.mjs`（默认只读；写入测试必须显式指定测试参数且标题匹配）；`spike/shared-session-probe.mjs`（独立后端对照）。
