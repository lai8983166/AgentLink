import { host, signal, Text, View, Scroll, List, safeAreaInsets, cleanup, type ListRef } from "nsh";
import { Input, AlertDialog, Sheet } from "nsh/base";
import { BackHandler } from "nsh/mobile";
import { Client, decisions } from "../core/client";
import { controls, policyLabels, relativeTime, statusLabel } from "../core/presentation";
import { Home } from "./Home";
import { Button, Card, Field, Row, Markdown, colors, inputStyle } from "./ui";
import type { DisplayHistoryItem } from "../../web/src/message-history";

const decisionLabels: Record<string, string> = { accept: "批准", acceptForSession: "本会话批准", decline: "拒绝", cancel: "取消" };
const deliveryLabels: Record<string, string> = { sending: "发送中", queued: "已排队", accepted: "已接收", failed: "失败", uncertain: "结果待确认" };

export function ClientApp() {
  const client = new Client({ call: (op, data) => host.call("client.call", { op, ...data }, { timeout: op === "bootstrap" ? 10000 : 120000 }) });
  const state = signal(client.view);
  client.onChange = () => state.set(client.view);
  cleanup(() => client.dispose());
  const url = signal(""); const token = signal("");
  const expanded = signal<Record<string, boolean>>({});
  const diff = signal<{ title: string; text: string } | null>(null);
  const following = signal(true);
  const insets = safeAreaInsets();
  let messages: ListRef | undefined;
  const edit = (key: "query" | "project" | "prompt" | "policy", value: string) => { client.view[key] = value; client.changed(); };
  const toggle = (id: string) => expanded.update(old => ({ ...old, [id]: !old[id] }));
  const open = (id: string) => { following.set(true); void client.open(id); };
  const back = () => { if (diff()) { diff.set(null); return true; } return client.back(); };
  const confirm = async (title: string, description: string, action: () => void) => {
    const result = await AlertDialog.show({ title, description, actions: [{ id: "cancel", label: "取消", role: "cancel" }, { id: "yes", label: "确认" }] });
    if (result.action === "yes") action();
  };
  host.on("client.socket", (event: any) => { try { client.socketEvent(event); } catch { client.error(new Error("实时数据不兼容，请刷新核对")); } });
  host.on("client.lifecycle", (value: unknown) => client.lifecycle(value === "active"));
  host.on("client.navigate", (value: any) => { if (value?.scope === state().pairing?.scope && state().pairing?.paired && typeof value.path === "string") client.navigate(value.path); });
  BackHandler.on("press", back);
  void client.bootstrap(host.params.pairing);

  function Pair() {
    return <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", padding: 12 }}>
      <View style={{ width: "100%", maxWidth: 360, alignSelf: "center", padding: 24, backgroundColor: colors.white, borderWidth: 2, borderColor: colors.ink, borderRadius: 18, boxShadow: "5px 5px 0 #221c0e", gap: 18 }}>
        <Text style={{ fontSize: 30, fontWeight: "bold", color: colors.ink }}>▣ AgentLink</Text>
        <Text style={{ color: colors.muted }}>// 粘贴电脑上的配对 token</Text>
        <Field label="服务器地址" value={url()} placeholder="https://agent.example.com" onChange={v => url.set(v)} keyboard="url" />
        <Field label="配对 token" value={token()} onChange={v => token.set(v)} masked />
        <Button label={state().busy ? "配对中…" : "配对"} disabled={state().busy || !url().trim() || !token().trim()} onPress={() => void client.pair(url(), token()).then(() => token.set(""))} />
        <Text style={{ fontSize: 12, color: colors.muted }}>NSH Android · 配对信息保存在本机</Text>
      </View>
    </Scroll>;
  }
  function History(p: { item: DisplayHistoryItem }) {
    const key = () => `${p.item.type}:${p.item.id}`;
    const tool = () => p.item.type === "toolCall" ? p.item : null;
    return <View style={{ marginVertical: 7, gap: 6, alignSelf: p.item.type === "userMessage" ? "flex-end" : "stretch", maxWidth: p.item.type === "userMessage" ? "82%" : "100%", padding: p.item.type === "agentMessage" ? 0 : 12, backgroundColor: p.item.type === "userMessage" ? "#fff0a8" : p.item.type === "agentMessage" ? "transparent" : colors.white, borderRadius: 12, borderWidth: p.item.type === "agentMessage" ? 0 : 1, borderColor: colors.line }}>
      <If when={p.item.type === "userMessage" || p.item.type === "agentMessage"}><Markdown text={p.item.type === "userMessage" || p.item.type === "agentMessage" ? p.item.text : ""} /></If>
      <If when={!!p.item.deliveryState}><Text style={{ fontSize: 11, color: colors.muted }}>{deliveryLabels[p.item.deliveryState!]}</Text><If when={p.item.deliveryState === "failed"}><Button small label="放回草稿" onPress={() => client.setDraft(p.item.type === "userMessage" ? p.item.text : "")} /></If></If>
      <If when={!!tool()}>
        <View role="button" accessibilityLabel={tool()?.kind === "fileChange" ? "查看文件差异" : "展开工具输出"} onPress={() => tool()?.kind === "fileChange" ? diff.set({ title: tool()!.target, text: tool()!.outputTail || "暂无可显示差异" }) : toggle(key())} style={{ gap: 4 }}>
          <Text style={{ fontSize: 13, color: colors.ink }}>{tool()?.kind === "fileChange" ? "✎" : "›"} {tool()?.cmd || tool()?.target}</Text>
          <Text style={{ fontSize: 11, color: colors.muted }}>{tool()?.diffStat ? `+${tool()!.diffStat!.added} −${tool()!.diffStat!.removed}` : `exit ${tool()?.exitCode ?? "—"} · ${((tool()?.durationMs ?? 0) / 1000).toFixed(1)}s`}</Text>
        </View>
        <If when={expanded()[key()]}><View selectable><Text style={{ fontSize: 13, color: colors.ink }}>{tool()?.outputTail || "暂无输出"}</Text></View></If>
      </If>
      <If when={p.item.type === "approval"}><Text style={{ color: colors.muted }}>{p.item.type === "approval" ? `${decisionLabels[p.item.decision] || p.item.decision} · ${p.item.command || "工具操作"}` : ""}</Text></If>
    </View>;
  }
  function Session() {
    const detail = () => state().detail;
    const session = () => detail()?.session;
    const control = () => controls(detail(), state().fresh, state().lastErrorCode);
    const allowed = () => control().drive && !state().busy;
    const conversation = () => (state(), client.conversation());
    return <View style={{ flex: 1, gap: 8 }}>
      <Row><Button small label="‹ 返回" onPress={back} /><View style={{ flex: 1, gap: 3 }}><Text style={{ fontSize: 17, fontWeight: "bold", color: colors.ink }}>● # {session()?.title || "读取会话…"}</Text><Text style={{ fontSize: 11, color: colors.muted }}>{session()?.agent === "claude" ? "Claude Code" : "Codex"} · {session()?.cwd}</Text></View><If when={control().interrupt}><Button small label="中断" disabled={state().busy} onPress={() => void client.action("interrupt")} /></If></Row>
      <If when={!!session()?.forkedFromId}><Text style={{ fontSize: 12, color: colors.muted }}>此会话从 #{session()?.forkedFromId?.slice(0, 8)} 接力而来</Text></If>
      <If when={!!session()?.forkedToId}><Card><Text>此会话已接力至新会话，最新进展在那里</Text><Button small label="打开接力会话 →" onPress={() => open(session()!.forkedToId!)} /></Card></If>
      <If when={control().desktop && !session()?.forkedToId}><Card><Text style={{ fontSize: 13, color: colors.accent }}>电脑端会话 · 当前仅观察。继续原会话或接管后可发送指令。</Text><Row><Button small label="继续原会话" disabled={!control().resume || state().busy} onPress={() => void client.action("resume")} /><Button small label="接管原会话" disabled={!control().takeover || state().busy} onPress={() => void client.action("takeover")} /></Row><If when={control().fork}><Button small label="接力为新会话（继承全部历史）" disabled={state().busy} onPress={() => void confirm("创建接力会话", "这会创建新的会话 ID，原会话继续保留。", () => void client.action("fork"))} /></If></Card></If>
      <If when={session()?.agent === "claude"}><Text style={{ fontSize: 12, color: colors.muted }}>原终端{session()?.terminal?.connected ? "已连接" : "未连接"} · {session()?.terminal?.permissionMode || "权限模式未知"}{session()?.terminal?.reason ? ` · ${session()?.terminal?.reason}` : ""}。问答和计划确认请回电脑终端处理。</Text></If>
      <Row><Text style={{ flex: 1, fontSize: 11, color: colors.muted }}>{state().fresh ? `已核对 · ${relativeTime(state().checkedAt)}` : "历史只读 · 等待联网核对"}{detail()?.historyPage ? ` · ${session()?.history.length}/${detail()?.historyPage?.total} 条` : ""}</Text><Button small label={state().refreshing ? "刷新中…" : "刷新输出"} disabled={state().refreshing} onPress={() => void client.refresh()} /></Row>
      <Row><Text style={{ flex: 1, fontSize: 12, color: session()?.status === "waiting_approval" ? "#a25315" : colors.muted }}>{session() ? statusLabel(session()!) : "读取中…"}{state().outbox.messages.some(m => m.state === "queued") ? " · 有指令排队中" : ""}</Text><If when={control().policy}><Button small label="审批策略" disabled={state().busy} onPress={() => void choosePolicy()} /></If></Row>
      <List ref={value => { messages = value; }} style={{ flex: 1 }} each={conversation().history} keyExtractor={item => `${item.type}:${item.id}`} estimatedItemSize={100} maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 80 }} onScroll={e => following.set(e.contentSize.height - e.offset.y - e.size.height < 90)}
        header={() => <View style={{ gap: 8 }}><If when={detail()?.historyPage?.hasMore}><Button small label="加载更早记录" disabled={state().busy} onPress={() => void client.older()} /></If><If when={conversation().archived.length > 0}><Button small label={`较早的本机发送记录（${conversation().archived.length}）`} onPress={() => toggle("archived")} /><If when={expanded().archived}><Each of={conversation().archived}>{m => <Text style={{ fontSize: 12, color: colors.muted }}>已接收 · {m().text}</Text>}</Each><Button small label="清除已接收的本机记录" onPress={() => void client.clearAccepted(conversation().archived.map(m => m.id))} /></If></If></View>}
        footer={() => <View style={{ gap: 10, paddingVertical: 10 }}><Each of={state().approvalResults}>{a => <Text style={{ fontSize: 12, color: colors.muted }}>{decisionLabels[a().decision]} · {a().command}</Text>}</Each><Each of={(session()?.approvals ?? []).filter(a => !state().approvalResults.some(r => r.id === a.approvalId))}>{a => <View style={{ gap: 10, padding: 16, backgroundColor: "#fff4cc", borderWidth: 1.5, borderColor: colors.ink, borderRadius: 12 }}><Text style={{ fontWeight: "bold", color: colors.ink }}>⚠ 等待你的审批</Text><Text style={{ color: colors.ink }}>{a().command || "文件改动"}</Text><Text style={{ fontSize: 12, color: colors.muted }}>{a().cwd}{"\n"}{a().reason}</Text><Row><Each of={decisions(a().availableDecisions)}>{d => <Button small label={decisionLabels[d()]} disabled={!allowed()} onPress={() => void client.approve(a().approvalId, d())} />}</Each></Row><If when={!decisions(a().availableDecisions).length}><Text>此审批类型请回电脑端处理。</Text></If></View>}</Each></View>}
        empty={() => <Text style={{ padding: 20, color: colors.muted }}>暂无可显示历史</Text>}>
        {item => <History item={item()} />}
      </List>
      <If when={!following()}><Button small label="回到底部 ↓" onPress={() => { messages?.scrollToEnd({ animated: true }); following.set(true); }} /></If>
      <If when={state().outbox.messages.some(m => m.state === "uncertain" || m.state === "queued")}><Text style={{ fontSize: 12, color: colors.muted }}>有指令结果待确认，不会自动重发。可核对结果，或输入一条新指令。</Text><Button small label="核对发送结果" disabled={state().busy} onPress={() => void client.recheck()} /></If>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingVertical: 8, borderTopWidth: 1, borderColor: colors.line }}><Input accessibilityLabel="消息输入" multiline submitBehavior="newline" placeholder={allowed() ? "输入指令…" : "当前只读，可保留草稿"} value={state().outbox.draft} onChange={({ value }) => client.setDraft(value)} style={{ ...inputStyle, flex: 1, minHeight: 46, maxHeight: 140 }} /><View role="button" accessibilityLabel="发送消息" disabled={!allowed() || !state().outbox.draft.trim()} onPress={() => void client.send()} style={{ padding: 12, backgroundColor: allowed() && state().outbox.draft.trim() ? colors.gold : colors.surface, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 12 }}><Text style={{ fontSize: 22, color: colors.ink }}>↑</Text></View></View>
    </View>;
  }
  async function choosePolicy() {
    const result = await AlertDialog.show({ title: "审批策略", description: "修改当前会话的审批策略", actions: Object.entries(policyLabels).map(([id, label]) => ({ id, label })) });
    if (result.action) void client.action("policy", { approvalPolicy: result.action });
  }
  function NewTask() {
    return <Sheet open={state().newTask} side="bottom" closeOnSwipe={!state().busy} closeOnEscape={!state().busy} closeOnBackdropPress={!state().busy} onOpenChange={({ open }) => { if (!open) client.closeNew(); }} backdropStyle={{ backgroundColor: "rgba(34,28,14,0.4)" }} popupStyle={{ backgroundColor: colors.paper, maxHeight: "82%", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 20 + insets().bottom }}>
      <Scroll contentStyle={{ gap: 16 }}><View style={{ width: 36, height: 4, backgroundColor: colors.line, borderRadius: 2, alignSelf: "center" }} /><Row><Text style={{ flex: 1, fontSize: 22, fontWeight: "bold", color: colors.ink }}>新任务</Text><Button small label="取消" disabled={state().busy} onPress={() => client.closeNew()} /></Row>
        <Text style={{ color: colors.muted }}>项目</Text><Button small label={state().project || "选择项目目录…"} disabled={state().busy} onPress={() => { client.view.browsing = !state().browsing; client.changed(); if (state().browsing) void client.browse(); }} />
        <If when={state().browsing}><Card><Text style={{ fontSize: 12, color: colors.muted }}>{state().fs?.path || "允许的根目录"}</Text><If when={!!state().fs?.path}><Row><Button small label="选择当前目录" onPress={() => client.chooseProject(state().fs.path)} /><Button small label="返回根目录" onPress={() => void client.browse()} /></Row></If><Each of={state().fs?.entries?.filter((e: any) => e.kind === "dir") ?? []}>{(e: any) => <Row><View style={{ flex: 1 }}><Button small label={e().name} onPress={() => client.chooseProject(e().path)} /></View><Button small label={`浏览 ${e().name}`} disabled={state().busy} onPress={() => void client.browse(e().path)} /></Row>}</Each><If when={state().busy}><Text>读取目录中…</Text></If></Card></If>
        <Row><Text style={{ color: colors.ink }}>Agent　Codex</Text><Text style={{ fontSize: 12, color: colors.muted }}>订阅账号</Text></Row><Text style={{ color: colors.muted }}>审批策略</Text><Row><Each of={Object.entries(policyLabels)}>{p => <View role="button" accessibilityLabel={p()[1]} onPress={() => edit("policy", p()[0])} style={{ flex: 1, padding: 10, borderRadius: 9, borderWidth: 1, borderColor: colors.ink, backgroundColor: state().policy === p()[0] ? colors.gold : colors.white }}><Text style={{ fontSize: 12, color: colors.ink }}>{p()[1]}</Text></View>}</Each></Row>
        <Field label="任务描述" value={state().prompt} onChange={v => edit("prompt", v)} multiline /><Button label={state().busy ? "创建中…" : "开始任务"} disabled={state().busy || !state().project || !state().prompt.trim()} onPress={() => void client.create()} />
        <If when={!!state().notice}><Text style={{ color: "#a25315", fontSize: 12 }}>{state().notice}</Text></If>
      </Scroll>
    </Sheet>;
  }
  function Settings() {
    return <Scroll style={{ flex: 1 }} contentStyle={{ gap: 16, paddingBottom: 24 }}>
      <Text style={{ color: colors.muted }}>连接</Text><Card><Text style={{ color: colors.ink }}>后台 {state().status?.daemonVersion || "—"} · {state().status?.mode || "待连接"}</Text><Text style={{ fontSize: 12, color: colors.muted }}>{state().pairing?.url}</Text></Card>
      <Text style={{ color: colors.muted }}>Claude Code</Text><Card><Text style={{ color: colors.muted, fontSize: 13 }}>从电脑原终端启动并连接 Claude Code，在首页「全部 Claude Code 会话」查看。权限问答和计划确认请在原终端完成。</Text></Card>
      <Text style={{ color: colors.muted }}>应用版本</Text><Card><Text style={{ color: colors.ink }}>NSH Android · {state().pairing?.version || "—"}</Text><Button small label="下载安装包 / 检查更新" onPress={() => void client.downloadPage()} /><Text style={{ fontSize: 12, color: colors.muted }}>下载页分别提供原版和 NSH 版；请选择 NSH 版覆盖安装。</Text></Card>
      <Text style={{ color: colors.muted }}>安卓任务通知</Text><Card><Text style={{ color: colors.ink }}>{state().notifications?.state || "读取通知状态…"}</Text><Text style={{ fontSize: 12, color: colors.muted }}>权限：{state().notifications?.permission ? "已允许" : "未允许"} · 后台服务：{state().notifications?.running ? "运行中" : "未运行"}</Text><Text style={{ fontSize: 12, color: colors.muted }}>最近通知：{relativeTime(state().notifications?.lastDeliveredAt ?? 0)}</Text><Button label={state().notifications?.enabled ? "关闭任务通知" : "开启任务通知"} disabled={state().busy} onPress={() => void client.notifications(state().notifications?.enabled ? "stop" : "start")} /><Row><Button small label="测试通知" disabled={state().busy || !state().notifications?.enabled} onPress={() => void client.notifications("test")} /><Button small label="后台运行设置" onPress={() => void client.notifications("settings")} /></Row><Text style={{ fontSize: 12, color: colors.muted }}>无需 Google 服务。请允许后台运行；重启手机后先打开应用。</Text></Card>
      <Text style={{ color: colors.muted }}>安全</Text><Button small label="审计日志 ›" onPress={() => client.screen("audit")} /><Text style={{ color: colors.muted }}>设备</Text><Button label={state().pairing?.pendingUnpair ? "重试解除配对" : "解除配对"} disabled={state().busy} onPress={() => void confirm("解除配对", "停止本机通知并注销本客户端，原客户端不受影响。", () => void client.unpair())} />
    </Scroll>;
  }
  function Audit() {
    return <List style={{ flex: 1 }} each={state().audit} keyExtractor={a => String(a.id)} estimatedItemSize={110} header={() => <Button small label="刷新审计日志" disabled={state().busy} onPress={() => void client.loadAudit(true)} />} empty={() => <Text style={{ padding: 20, color: colors.muted }}>{state().busy ? "读取中…" : state().auditLoaded ? "暂无审计记录" : "读取失败，请重试"}</Text>} footer={() => <If when={state().auditCursor !== null}><Button small label="加载更多" disabled={state().busy} onPress={() => void client.loadAudit()} /></If>}>
      {a => <View style={{ gap: 7, paddingVertical: 16, borderBottomWidth: 1, borderColor: colors.line }}><Text style={{ color: colors.ink }}>{decisionLabels[a().decision] || a().decision} · {a().kind}</Text><Text style={{ fontSize: 12, color: colors.muted }}>{a().project} · {relativeTime(a().at)}</Text><Text style={{ fontSize: 13, color: colors.ink }}>{a().command || "文件改动"}</Text></View>}
    </List>;
  }
  return <View style={{ flex: 1, backgroundColor: state().screen === "home" ? colors.white : colors.paper, paddingTop: insets().top + (state().screen === "home" ? 0 : 10), paddingBottom: insets().bottom, paddingHorizontal: state().screen === "home" ? 0 : 16, gap: state().screen === "home" ? 0 : 12 }}>
    <If when={state().screen === "settings" || state().screen === "audit"}><Row><Button small label="‹ 返回" onPress={back} /><Text style={{ fontSize: 22, fontWeight: "bold", color: colors.ink }}>{state().screen === "audit" ? "审计日志" : "设置"}</Text></Row></If>
    <If when={!!state().notice && !state().newTask}><View style={{ padding: 10, backgroundColor: "#fff0d4", borderRadius: 8 }}><Text style={{ color: "#7d4918", fontSize: 13 }}>{state().notice}</Text></View></If>
    <If when={state().startup === "loading"}><Text style={{ padding: 24, color: colors.muted }}>正在恢复本机配对…</Text></If>
    <If when={state().startup === "error"}><Card><Text>无法恢复本机配对</Text><Text>已保存的凭据不会被清除，请重试恢复。</Text><Button label="重试恢复配对" onPress={() => void client.bootstrap()} /></Card></If>
    <If when={state().startup === "ready" && !state().pairing?.paired && !state().pairing?.pendingUnpair}><Pair /></If>
    <If when={state().pairing?.pendingUnpair || (state().pairing?.paired && state().screen === "settings")}><Settings /></If>
    <If when={state().pairing?.paired && state().screen === "home"}><Home client={client} state={() => state()} open={open} /></If>
    <If when={state().pairing?.paired && state().screen === "session"}><Session /></If>
    <If when={state().pairing?.paired && state().screen === "audit"}><Audit /></If>
    <NewTask />
    <If when={!!diff()}><View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, padding: 16, paddingTop: insets().top + 10, paddingBottom: insets().bottom, backgroundColor: colors.paper, gap: 14 }}><Row><Button small label="关闭差异" onPress={() => diff.set(null)} /><Text style={{ flex: 1, color: colors.ink }}>{diff()?.title}</Text></Row><Scroll style={{ flex: 1 }}><View selectable><Each of={(diff()?.text ?? "").split("\n")}>{line => <Text style={{ fontSize: 13, color: line().startsWith("+") ? "#1f8a3b" : line().startsWith("-") ? "#d24430" : colors.ink, backgroundColor: line().startsWith("+") ? "#e5f5e8" : line().startsWith("-") ? "#ffe7e4" : "transparent", padding: 2 }}>{line() || " "}</Text>}</Each></View></Scroll></View></If>
  </View>;
}
