import { CollageSlash, CollagePaper } from "./Collage";
import { themedStyle, isPunk, uiTheme } from "../../shared/src/ui-theme";
import { host, signal, View, Scroll, List, safeAreaInsets, cleanup, type ListRef } from "nsh";
import { Input, AlertDialog } from "nsh/base";
import { BackHandler } from "nsh/mobile";
import { Client } from "../core/client";
import { controls, policyLabels, statusLabel } from "../core/presentation";
import { Settings } from "./Settings";
import { NewTask } from "./NewTask";
import { Icon, IconButton } from "./Icon";
import { Home } from "./Home";
import { Audit } from "./Audit";
import { Diff, type DiffContent } from "./Diff";
import { Tool } from "./Tool";
import { OlderDeliveries } from "./OlderDeliveries";
import { Approval, ResolvedApproval } from "./Approval";
import { Button, Card, Row, Markdown, colors, inputStyle, Text, fonts } from "./ui";
import type { DisplayHistoryItem } from "../../web/src/message-history";

const decisionLabels: Record<string, string> = { accept: "批准", acceptForSession: "批准（本会话不再询问）", decline: "拒绝（agent 继续）", cancel: "拒绝并中断" };
const deliveryLabels: Record<string, string> = { sending: "发送中", queued: "已排队", accepted: "已接收", failed: "失败", uncertain: "结果待确认" };

export function ClientApp() {
  const client = new Client({ call: (op, data) => host.call("client.call", { op, ...data }, { timeout: op === "bootstrap" ? 10000 : 120000 }) });
  const state = signal(client.view);
  client.onChange = () => state.set(client.view);
  cleanup(() => client.dispose());
  const url = signal(""); const token = signal("");
  const expanded = signal<Record<string, boolean>>({});
  const diff = signal<DiffContent | null>(null);
  const following = signal(true);
  const insets = safeAreaInsets();
  let messages: ListRef | undefined;
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
  // The browser preview host has no Android back dispatcher.
  if (typeof BackHandler.on === "function") BackHandler.on("press", back);
  void client.bootstrap(host.params.pairing);

  function Pair() {
    return <Scroll style={themedStyle({ flex: 1, backgroundColor: isPunk ? "transparent" : colors.paper })} contentStyle={themedStyle({ flexGrow: 1, justifyContent: "center", padding: 24 })}>
      <View style={themedStyle({ width: "100%", maxWidth: 360, alignSelf: "center", padding: 24, backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 16, boxShadow: "4px 4px 0 #221c0e" })}><CollageSlash />
        <View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 })}><View style={themedStyle({ width: 15, height: 15, borderRadius: 4, backgroundColor: colors.gold, borderWidth: 1.5, borderColor: colors.ink, boxShadow: "1.5px 1.5px 0 #221c0e" })} /><Text style={themedStyle({ fontSize: 18, fontWeight: 700, color: colors.ink })}>AgentLink</Text></View>
        <Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 13, color: colors.muted, marginBottom: 16 })}>// 粘贴电脑上的配对 token</Text>
        <Input accessibilityLabel="服务器地址" value={url()} onChange={({ value }) => url.set(value)} keyboardType="url" autoCapitalize="none" autoCorrect={false} placeholder="https://你的 AgentLink 地址" style={themedStyle({ ...inputStyle, lineHeight: 20, borderWidth: 1, borderColor: "#767676", borderRadius: 0, marginBottom: 12 })} />
        <Input accessibilityLabel="配对 token" value={token()} onChange={({ value }) => token.set(value)} masked autoCapitalize="none" autoCorrect={false} placeholder="agentlink token" style={themedStyle({ ...inputStyle, lineHeight: 22, fontFamily: fonts.mono, backgroundColor: colors.surface, borderRadius: 12, marginBottom: 12 })} />
        <If when={!!state().notice}><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 12, color: "#d24430", marginBottom: 10 })}>{state().notice}</Text></If>
        <Button label={state().busy ? "正在连接…" : "配对"} disabled={state().busy || !url().trim() || !token().trim()} onPress={() => void client.pair(url(), token()).then(() => token.set(""))} />
      </View>
    </Scroll>;
  }
  function History(p: { item: DisplayHistoryItem }) {
    const key = () => `${p.item.type}:${p.item.id}`;
    const tool = () => p.item.type === "toolCall" ? p.item : null;
    return <><If when={!!tool()}><Tool item={tool()!} expanded={!!expanded()[key()]} open={() => tool()!.kind === "fileChange" ? diff.set({ title: tool()!.target, text: tool()!.outputTail || "", added: tool()!.diffStat?.added, removed: tool()!.diffStat?.removed }) : toggle(key())} /></If><If when={!tool()}><View style={themedStyle({ marginTop: 14, marginBottom: 0, marginRight: 4, gap: 6, alignSelf: p.item.type === "userMessage" ? "flex-end" : "stretch", maxWidth: p.item.type === "userMessage" ? "82%" : "100%", paddingVertical: p.item.type === "agentMessage" ? 0 : 10, paddingHorizontal: p.item.type === "agentMessage" ? 2 : 14, backgroundColor: p.item.type === "userMessage" ? (isPunk ? "#151515" : colors.gold) : p.item.type === "agentMessage" ? "transparent" : colors.white, borderRadius: p.item.type === "userMessage" ? 16 : 12, borderBottomRightRadius: p.item.type === "userMessage" ? 6 : 12, borderWidth: p.item.type === "agentMessage" ? 0 : 1.5, borderColor: colors.ink, boxShadow: p.item.type === "agentMessage" ? "none" : "3px 3px 0 #221c0e" })}>
      <If when={p.item.type === "userMessage"}><Text style={themedStyle({ fontSize: 14, lineHeight: 23.1, color: isPunk ? "#ffffff" : colors.ink })}>{p.item.type === "userMessage" ? p.item.text : ""}</Text></If>
      <If when={p.item.type === "agentMessage"}><Markdown text={p.item.type === "agentMessage" ? p.item.text : ""} /></If>
      <If when={!!p.item.deliveryState}><Text style={themedStyle({ fontSize: 11, color: isPunk ? "#dddddd" : colors.muted })}>{deliveryLabels[p.item.deliveryState!]}</Text><If when={p.item.deliveryState === "failed"}><Button small label="放回草稿" onPress={() => client.setDraft(p.item.type === "userMessage" ? p.item.text : "")} /></If></If>
      <If when={p.item.type === "approval"}><Text style={themedStyle({ color: colors.muted })}>{p.item.type === "approval" ? `${decisionLabels[p.item.decision] || p.item.decision} · ${p.item.command || "工具操作"}` : ""}</Text></If>
    </View></If></>;
  }
  function Session() {
    const detail = () => state().detail;
    const session = () => detail()?.session;
    const control = () => controls(detail(), state().fresh, state().lastErrorCode);
    const allowed = () => control().drive && !state().busy;
    const conversation = () => (state(), client.conversation());
    return <View style={themedStyle({ flex: 1, backgroundColor: isPunk ? "transparent" : colors.paper })}>
      <View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1.5, borderColor: colors.ink, backgroundColor: colors.white })}><IconButton plain name="back" label="‹ 返回" onPress={back} /><View style={themedStyle({ flex: 1, gap: 1, minWidth: 0 })}><View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 8 })}><View style={themedStyle({ width: 9, height: 9, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 3, backgroundColor: session()?.status === "running" ? colors.accent : session()?.status === "waiting_approval" ? colors.gold : session()?.status === "done" ? "#2fae52" : "transparent" })} /><Text style={themedStyle({ flexShrink: 1, fontSize: 16, fontWeight: 700, lineHeight: 22, numberOfLines: 1, textOverflow: "ellipsis" })}><Text style={themedStyle({ fontFamily: fonts.mono, color: "#c4a500" })}>#</Text>{session()?.title || "读取会话…"}</Text><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 9, lineHeight: 14, fontWeight: 700, color: colors.muted, borderWidth: 1, borderColor: "rgba(34,28,14,0.55)", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 })}>{session()?.agent === "claude" ? "CLAUDE" : "CODEX"}</Text></View><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: "#a29877", numberOfLines: 1, textOverflow: "ellipsis" })}>{session()?.cwd}</Text></View><If when={control().interrupt}><IconButton name="stop" label="中断" disabled={state().busy} onPress={() => void client.action("interrupt")} /></If></View>
      <If when={!!session()?.forkedFromId}><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 11.5, color: "#a29877", paddingVertical: 8, paddingHorizontal: 16, borderBottomWidth: 1, borderStyle: "dotted", borderColor: colors.line })}>此会话从 #{session()?.forkedFromId?.slice(0, 8)} 接力而来</Text></If>
      <If when={!!session()?.forkedToId}><View style={themedStyle({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", paddingVertical: 10, paddingHorizontal: 16, gap: 10, borderBottomWidth: 1.5, borderColor: colors.ink, backgroundColor: colors.gold })}><Text style={themedStyle({ fontSize: 12.5 })}>此会话已接力至新会话，最新进展在那里</Text><Button small primary label="打开接力会话 →" onPress={() => open(session()!.forkedToId!)} /></View></If>
      <If when={control().desktop && !session()?.forkedToId}><View style={themedStyle({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", paddingVertical: 10, paddingHorizontal: 16, gap: 10, borderBottomWidth: 1.5, borderColor: colors.ink, backgroundColor: control().fork ? "#fce9e4" : colors.gold })}><Text style={themedStyle({ fontSize: 12.5, fontWeight: 550, color: control().fork ? "#d24430" : colors.ink })}>{control().fork ? "委托通道不可用（找不到会话拥有者）" : session()?.desktopGone ? "电脑端连接不可用；会话已关闭时，可继续原会话" : (session()?.activeVia || "电脑端") + "原会话 · 可观察或接管"}</Text><Button small primary label="继续原会话" disabled={!control().resume || state().busy} onPress={() => void client.action("resume")} /><Button small primary label="接管此会话" disabled={!control().takeover || state().busy} onPress={() => void client.action("takeover")} /><If when={control().fork}><Button small label="接力为新会话（继承全部历史）" disabled={state().busy} onPress={() => void confirm("创建接力会话", "这会创建新的会话 ID，原会话继续保留。", () => void client.action("fork"))} /></If></View></If>
      <If when={session()?.agent === "claude"}><View style={themedStyle({ paddingVertical: 9, paddingHorizontal: 16, borderBottomWidth: 1, borderColor: colors.ink, backgroundColor: session()?.terminal?.inputBlocked ? colors.gold : colors.white })}><Text style={themedStyle({ fontSize: 12 })}>{session()?.terminal?.connected ? "Claude 原终端会话 · 手机和电脑共用同一会话" : "Claude 终端未连接，请保持电脑终端运行并加载 AgentLink 插件"}</Text><Text style={themedStyle({ fontSize: 12, color: colors.muted, marginTop: 4 })}>{session()?.terminal?.reason || "权限沿用电脑终端；关闭手机不会停止任务"}</Text><If when={!!session()?.terminal?.permissionMode}><Text style={themedStyle({ fontSize: 12, marginTop: 4 })}>终端权限：{session()?.terminal?.permissionMode}</Text></If></View></If>
      <View style={themedStyle({ paddingVertical: 4, paddingHorizontal: 16 })}><Text style={themedStyle({ fontSize: 11, lineHeight: 17, color: colors.muted })}>{state().ws === "open" ? "手机与后台已连接" : "实时连接中 · 定时核对输出"}{session()?.desktopManaged ? " · " + (session()?.desktopGone ? "电脑端未连接" : control().drive ? "原会话可控制" : "原会话观察中") : ""} · {state().fresh ? "内容核对于 " + new Date(state().checkedAt).toLocaleTimeString() : "本地缓存，正在核对最新内容"}</Text><View role="button" accessibilityLabel="刷新输出" disabled={state().refreshing} onPress={() => void client.refresh()} style={themedStyle({ alignSelf: "flex-start", height: 42, marginLeft: 8, paddingHorizontal: 7, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: colors.ink, borderRadius: 12, backgroundColor: colors.white, boxShadow: "3px 3px 0 #221c0e" })}><Text style={themedStyle({ fontSize: 11, fontWeight: 700, color: colors.muted })}>{state().refreshing ? "刷新中…" : "刷新输出"}</Text></View></View>
      <View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 16, borderBottomWidth: 1.5, borderColor: colors.ink, backgroundColor: session()?.status === "waiting_approval" ? colors.gold : colors.white })}><View style={themedStyle({ width: 9, height: 9, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 3, backgroundColor: session()?.status === "running" ? colors.accent : session()?.status === "waiting_approval" ? colors.gold : session()?.status === "done" ? "#2fae52" : session()?.status === "idle" ? "#c9bfa8" : "transparent" })} /><Text style={themedStyle({ flex: 1, fontSize: 12 })}>{session()?.status === "waiting_approval" ? "等待批准" : session() ? statusLabel(session()!) : "读取中…"}{state().outbox.messages.some(m => m.state === "queued") ? " · 有指令排队中" : ""}</Text><If when={!!state().activity}><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, maxWidth: "35%", numberOfLines: 1, paddingVertical: 1, paddingHorizontal: 6, borderWidth: 1, borderColor: "#e2d6b4", borderRadius: 5, backgroundColor: colors.surface })}>{state().activity}</Text></If><If when={state().queued > 0}><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 11, color: colors.muted })}>· {state().queued} 条排队</Text></If><If when={control().policy}><View role="button" accessibilityLabel="审批策略" onPress={() => !state().busy && void choosePolicy()}><Text style={themedStyle({ fontSize: 11, color: colors.muted, textDecorationLine: "underline" })}>审批策略</Text></View></If></View>
      <View style={themedStyle({ flex: 1 })}><List ref={value => { messages = value; }} style={themedStyle({ flex: 1 })} contentStyle={themedStyle({ paddingHorizontal: 16 })} each={conversation().history} keyExtractor={item => `${item.type}:${item.id}`} estimatedItemSize={100} maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 80 }} onScroll={e => following.set(e.contentSize.height - e.offset.y - e.size.height < 90)}
        header={() => <View style={themedStyle({ gap: 8, paddingTop: 12 })}><If when={detail()?.historyPage?.hasMore}><Text style={themedStyle({ fontSize: 11, color: colors.muted })}>已加载 {session()?.history.length} / {detail()?.historyPage?.total} 条记录</Text></If><If when={detail()?.historyPage?.hasMore}><Button small label="加载更早记录" disabled={state().busy} onPress={() => void client.older()} /></If><If when={conversation().archived.length > 0}><OlderDeliveries messages={conversation().archived} expanded={!!expanded().archived} toggle={() => toggle("archived")} dismiss={() => void client.clearAccepted(conversation().archived.map(m => m.id))} /></If></View>}
        footer={() => <View style={themedStyle({ paddingBottom: 16 })}><Each of={state().approvalResults}>{a => <ResolvedApproval command={a().command} decision={a().decision} />}</Each><Each of={(session()?.approvals ?? []).filter(a => !state().approvalResults.some(r => r.id === a.approvalId))}>{a => <Approval value={a()} allowed={allowed()} decide={decision => void client.approve(a().approvalId, decision)} />}</Each></View>}
        empty={() => <View />}>
        {item => <History item={item()} />}
      </List>
      <If when={!following()}><View role="button" accessibilityLabel="回到底部 ↓" onPress={() => { messages?.scrollToEnd({ animated: true }); following.set(true); }} style={themedStyle({ position: "absolute", bottom: 12, alignSelf: "center", paddingVertical: 8, paddingHorizontal: 16, backgroundColor: colors.ink, borderRadius: 99, borderWidth: 1.5, borderColor: colors.ink, boxShadow: "3px 3px 0 #ffd700" })}><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 11.5, color: "#fff3c4" })}>回到底部 ↓</Text></View></If></View>
      <If when={state().outbox.messages.some(m => m.state === "uncertain" || m.state === "queued")}><Text style={themedStyle({ fontSize: 12, color: colors.muted })}>有指令结果待确认，不会自动重发。可核对结果，或输入一条新指令。</Text><Button small label="核对发送结果" disabled={state().busy} onPress={() => void client.recheck()} /></If>
      <View style={themedStyle({ flexDirection: "row", alignItems: "flex-end", gap: 9, paddingTop: 10, paddingBottom: 14, paddingHorizontal: 14, borderTopWidth: 1, borderColor: colors.line })}><Input accessibilityLabel="消息输入" multiline submitBehavior="newline" placeholder={allowed() ? session()?.status === "running" || session()?.status === "waiting_approval" ? "发送消息…（运行中将排队）" : "发送消息…" : control().desktop ? "观察模式 · 点上方「接管此会话」后可驱动" : "当前只读，可保留草稿"} value={state().outbox.draft} onChange={({ value }) => client.setDraft(value)} style={themedStyle({ ...inputStyle, flex: 1, minWidth: 0, minHeight: 42, maxHeight: 140, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 14, boxShadow: "2px 2px 0 #221c0e" })} /><View role="button" accessibilityLabel="发送消息" disabled={!allowed() || !state().outbox.draft.trim()} onPress={() => void client.send()} style={themedStyle({ width: 46, height: 42, alignItems: "center", justifyContent: "center", backgroundColor: uiTheme.primary, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 12, boxShadow: "3px 3px 0 #221c0e" })}><Icon name="send" /></View></View>
    </View>;
  }
  async function choosePolicy() {
    const result = await AlertDialog.show({ title: "审批策略", description: "修改当前会话的审批策略", actions: Object.entries(policyLabels).map(([id, label]) => ({ id, label })) });
    if (result.action) void client.action("policy", { approvalPolicy: result.action });
  }
  return <View style={themedStyle({ flex: 1, backgroundColor: colors.white, paddingTop: insets().top, paddingBottom: insets().bottom })}><CollagePaper />
    <If when={state().screen === "settings" || state().screen === "audit"}><View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: colors.white, borderBottomWidth: 1.5, borderColor: colors.ink })}><IconButton plain name="back" label="‹ 返回" onPress={back} /><Text style={themedStyle({ fontSize: 16, fontWeight: 700, lineHeight: 22 })}>{state().screen === "audit" ? "审计日志" : "设置"}</Text></View></If>
    <If when={!!state().notice && !state().newTask && !!state().pairing?.paired}><View style={themedStyle({ padding: 10, backgroundColor: "#fff0d4", borderRadius: 8 })}><Text style={themedStyle({ color: "#7d4918", fontSize: 13 })}>{state().notice}</Text></View></If>
    <If when={state().startup === "loading"}><Text style={themedStyle({ padding: 24, color: colors.muted })}>正在恢复本机配对…</Text></If>
    <If when={state().startup === "error"}><Card><Text>无法恢复本机配对</Text><Text>已保存的凭据不会被清除，请重试恢复。</Text><Button label="重试恢复配对" onPress={() => void client.bootstrap()} /></Card></If>
    <If when={state().startup === "ready" && !state().pairing?.paired && !state().pairing?.pendingUnpair}><Pair /></If>
    <If when={state().pairing?.pendingUnpair || (state().pairing?.paired && state().screen === "settings")}><Settings client={client} state={() => state()} unpair={() => void confirm("解除配对", "停止本机通知并注销本客户端，原客户端不受影响。", () => void client.unpair())} /></If>
    <If when={state().pairing?.paired && state().screen === "home"}><Home client={client} state={() => state()} open={open} /></If>
    <If when={state().pairing?.paired && state().screen === "session"}><Session /></If>
    <If when={state().pairing?.paired && state().screen === "audit"}><Audit client={client} state={() => state()} /></If>
    <NewTask client={client} state={() => state()} bottom={insets().bottom} />
    <If when={!!diff()}><Diff value={diff()!} close={() => diff.set(null)} top={insets().top} bottom={insets().bottom} /></If>
  </View>;
}
