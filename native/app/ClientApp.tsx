import { host, signal, Text, View, Scroll, List, safeAreaInsets, Clipboard, cleanup, type ListRef, type JSX } from "nsh";
import { Input, AlertDialog } from "nsh/base";
import { BackHandler } from "nsh/mobile";
import { Client, canControl, decisions } from "../core/client";
import type { HistoryItem } from "../../shared/src/domain";

const colors = { ink: "#182d35", muted: "#637881", paper: "#f2f5f3", white: "#ffffff", accent: "#14695e", line: "#d7e1dc" };
const labels: Record<string, string> = { running: "运行中", waiting_approval: "待审批", done: "已完成", idle: "空闲", error: "出错", unknown: "待核对", sending: "发送中", queued: "已排队", accepted: "已接收", failed: "失败", uncertain: "结果待确认", accept: "批准", acceptForSession: "本会话批准", decline: "拒绝", cancel: "取消", untrusted: "逐项询问", "on-request": "按需询问", never: "不询问" };

export function ClientApp() {
  const client = new Client({ call: (op, data) => host.call("client.call", { op, ...data }, { timeout: 120000 }) });
  const state = signal(client.view);
  client.onChange = () => state.set(client.view);
  cleanup(() => client.dispose());
  const url = signal(""); const token = signal("");
  const insets = safeAreaInsets();
  const expanded = signal<Record<string, boolean>>({});
  const following = signal(true);
  let list: ListRef | undefined;
  host.on("client.socket", (event: any) => { try { client.socketEvent(event); } catch { client.error(new Error("实时数据不兼容，请刷新核对")); } });
  host.on("client.lifecycle", (value: unknown) => client.lifecycle(value === "active"));
  host.on("client.navigate", (value: any) => {
    if (value?.scope !== state().pairing?.scope || !state().pairing?.paired) return;
    if (typeof value.path === "string") client.navigate(value.path);
  });
  BackHandler.on("press", () => {
    if (state().screen !== "home") { client.home(); return true; }
    return false;
  });
  void client.bootstrap();

  const edit = (key: "query" | "project" | "prompt" | "policy", value: string) => { client.view[key] = value; client.changed(); };
  const confirm = async (title: string, description: string, action: () => void) => {
    const result = await AlertDialog.show({ title, description, actions: [{ id: "cancel", label: "取消", role: "cancel" }, { id: "yes", label: "继续" }] });
    if (result.action === "yes") action();
  };
  const toggle = (id: string) => expanded.update(previous => ({ ...previous, [id]: !previous[id] }));
  const open = (id: string) => { following.set(true); void client.open(id); };

  function Pair() {
    return <Scroll style={{ flex: 1 }} contentStyle={{ padding: 24, gap: 20 }}>
      <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "bold" }}>手机上的远程驾驶舱</Text>
      <Text style={{ fontSize: 32, fontWeight: "bold", color: colors.ink }}>连接你的电脑</Text>
      <Text style={{ fontSize: 16, color: colors.muted }}>输入现有 AgentLink 后台的 HTTPS 根地址和配对 token。</Text>
      <Field label="服务器地址" value={url()} placeholder="https://agent.example.com" onChange={value => url.set(value)} keyboard="url" />
      <Field label="配对 token" value={token()} onChange={value => token.set(value)} masked />
      <Button label={state().busy ? "正在连接…" : "连接后台"} disabled={state().busy || !url().trim() || !token().trim()}
        onPress={() => { void client.pair(url(), token()).then(() => token.set("")); }} />
      <Text style={{ fontSize: 13, color: colors.muted }}>凭据加密保存在本机。NSH 版与原客户端可同时安装，配对各自独立。</Text>
    </Scroll>;
  }
  function Home() {
    return <View style={{ flex: 1, gap: 12 }}>
      <Row><Button small label="最近" onPress={() => client.home("recent")} /><Button small label="全部 Codex" onPress={() => client.home("codex")} /><Button small label="全部 Claude" onPress={() => client.home("claude")} /></Row>
      <Input accessibilityLabel="搜索会话" placeholder="搜索标题或项目路径" value={state().query} onChange={({ value }) => edit("query", value)} style={inputStyle} />
      <Row><Text style={{ color: colors.muted, fontSize: 13 }}>{state().agent === "recent" ? "最近 30 天" : "全部历史"} · {(state(), client.filtered().length)} 个会话</Text>
        <Button small label="新建任务" disabled={state().busy} onPress={() => { client.screen("new"); void client.browse(); }} /></Row>
      <List style={{ flex: 1 }} each={(state(), client.filtered().slice(0, state().limit))} keyExtractor={s => s.id} estimatedItemSize={124}
        onLoadMore={() => { client.view.limit += 50; client.changed(); }}
        empty={() => <Text style={{ padding: 24, color: colors.muted }}>没有匹配的会话。可以刷新或切换到全部目录。</Text>}>
        {(item) => <View role="button" accessibilityLabel={item().title || "未命名会话"} onPress={() => open(item().id)} style={{ padding: 18, marginBottom: 10, backgroundColor: colors.white, borderRadius: 14, gap: 7 }}>
          <Row><Text style={{ fontSize: 12, color: colors.accent, fontWeight: "bold" }}>{item().agent.toUpperCase()}</Text><Text style={{ color: item().pendingApprovals ? "#a25315" : colors.muted, fontSize: 12 }}>{labels[item().status]}{item().pendingApprovals ? ` · ${item().pendingApprovals} 项审批` : ""}</Text></Row>
          <Text style={{ fontSize: 18, fontWeight: "bold", color: colors.ink }}>{item().title || "未命名会话"}</Text>
          <Text style={{ fontSize: 12, color: colors.muted }}>{item().cwd}</Text>
          <Text style={{ fontSize: 14, color: colors.muted }}>{item().preview.slice(0, 160)}</Text>
        </View>}
      </List>
    </View>;
  }
  function Session() {
    const detail = () => state().detail;
    const session = () => detail()?.session;
    const allowed = () => canControl(detail(), state().fresh) && !state().busy;
    return <View style={{ flex: 1, gap: 8 }}>
      <Text style={{ fontSize: 19, fontWeight: "bold", color: colors.ink }}>{session()?.title || "读取会话…"}</Text>
      <Text style={{ fontSize: 12, color: colors.muted }}>{session()?.cwd}</Text>
      <Text style={{ fontSize: 13, color: colors.accent }}>{labels[session()?.status ?? "unknown"]} · {state().fresh ? "已联网核对" : "只读，等待核对"}</Text>
      <Scroll horizontal style={{ maxHeight: 48 }} contentStyle={{ flexDirection: "row", gap: 8 }}>
        <If when={session()?.agent === "codex"}>
          <Button small label="接管原会话" disabled={!state().fresh || state().busy} onPress={() => void client.action("takeover")} />
          <Button small label="继续原会话" disabled={!state().fresh || state().busy} onPress={() => void client.action("resume")} />
          <Button small label="接力为新会话" disabled={!state().fresh || state().busy} onPress={() => void confirm("创建接力会话", "这会创建新的会话 ID，原会话继续保留。", () => void client.action("fork"))} />
          <Button small label="审批策略" disabled={!allowed()} onPress={() => void choosePolicy()} />
        </If>
        <Button small label="中断" disabled={!allowed() || (session()?.agent === "claude" && !session()?.terminal?.canInterrupt)} onPress={() => void client.action("interrupt")} />
      </Scroll>
      <If when={session()?.agent === "claude" && (!session()?.terminal?.connected || session()?.terminal?.inputBlocked)}>
        <Text style={{ fontSize: 13, color: "#935015" }}>{session()?.terminal?.reason || "原终端未连接。问答和计划确认请回电脑终端处理。"}</Text>
      </If>
      <If when={(session()?.approvals?.length ?? 0) > 0}>
        <Scroll style={{ maxHeight: 200 }} contentStyle={{ gap: 8 }}>
          <Each of={session()?.approvals ?? []}>{a => <Card>
            <Text style={{ fontWeight: "bold", color: "#935015" }}>等待审批 · {a().kind}</Text>
            <Text style={{ fontSize: 14, color: colors.ink }}>{a().command || "工具操作"}</Text>
            <Text style={{ fontSize: 12, color: colors.muted }}>{a().cwd}{"\n"}{a().reason}</Text>
            <Row><Each of={decisions(a().availableDecisions)}>{d => <Button small label={labels[d()]} disabled={!allowed()} onPress={() => void client.approve(a().approvalId, d())} />}</Each></Row>
            <If when={!decisions(a().availableDecisions).length}><Text>此审批类型请回电脑端处理。</Text></If>
          </Card>}</Each>
        </Scroll>
      </If>
      <List ref={value => { list = value; }} style={{ flex: 1 }} each={session()?.history ?? []} keyExtractor={item => `${item.type}:${item.id}`} estimatedItemSize={120}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 80 }}
        onScroll={e => following.set(e.contentSize.height - e.offset.y - e.size.height < 90)}
        header={() => <If when={detail()?.historyPage?.hasMore}><Button small label="加载更早记录" disabled={state().busy} onPress={() => void client.older()} /></If>}
        empty={() => <Text style={{ padding: 20, color: colors.muted }}>暂无可显示历史</Text>}>
        {item => <History item={item()} expanded={!!expanded()[`${item().type}:${item().id}`]} toggle={() => toggle(`${item().type}:${item().id}`)} />}
      </List>
      <If when={!following()}><Button small label="回到底部" onPress={() => { list?.scrollToEnd({ animated: true }); following.set(true); }} /></If>
      <If when={state().outbox.messages.length > 0}>
        <Scroll style={{ maxHeight: 100 }} contentStyle={{ gap: 6 }}>
          <Each of={state().outbox.messages}>{m => <View style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ flex: 1, fontSize: 12, color: colors.muted }}>{labels[m().state]} · {m().text.slice(0, 100)}</Text>
            <If when={m().state === "failed"}><Button small label="放回草稿" onPress={() => client.setDraft(m().text)} /></If>
          </View>}</Each>
          <Button small label="核对发送结果" disabled={state().busy} onPress={() => void client.recheck()} />
        </Scroll>
      </If>
      <Input accessibilityLabel="消息输入" multiline submitBehavior="newline" placeholder={allowed() ? "给这个会话发消息…" : "草稿可编辑，控制就绪后发送"}
        value={state().outbox.draft} onChange={({ value }) => client.setDraft(value)} style={{ ...inputStyle, minHeight: 66, maxHeight: 150 }} />
      <Button label={state().busy ? "处理中…" : "发送消息"} disabled={!allowed() || !state().outbox.draft.trim()} onPress={() => void client.send()} />
    </View>;
  }
  async function choosePolicy() {
    const result = await AlertDialog.show({ title: "审批策略", description: "修改当前会话的审批策略", actions: ["untrusted", "on-request", "never"].map(id => ({ id, label: labels[id] })) });
    if (result.action) void client.action("policy", { approvalPolicy: result.action });
  }
  function NewTask() {
    return <Scroll style={{ flex: 1 }} contentStyle={{ gap: 16 }}>
      <Text style={{ fontSize: 24, color: colors.ink, fontWeight: "bold" }}>新建 Codex 任务</Text>
      <Field label="项目路径" value={state().project} onChange={v => edit("project", v)} />
      <Button small label="浏览项目目录" disabled={state().busy} onPress={() => void client.browse(state().project)} />
      <If when={state().fs}>
        <Card><Text style={{ fontSize: 13, color: colors.muted }}>{state().fs?.path || "允许的根目录"}</Text>
          <Row><Button small label="选择当前目录" disabled={!state().fs?.path} onPress={() => edit("project", state().fs.path)} /><Button small label="返回根目录" onPress={() => void client.browse()} /></Row>
          <Each of={state().fs?.entries?.filter((e: any) => e.kind === "dir") ?? []}>{(e: any) => <Button small label={e().name} onPress={() => void client.browse(e().path)} />}</Each>
        </Card>
      </If>
      <Text style={{ color: colors.muted }}>审批策略：{labels[state().policy]}</Text>
      <Row><Each of={["untrusted", "on-request", "never"]}>{p => <Button small label={labels[p()]} onPress={() => edit("policy", p())} />}</Each></Row>
      <Field label="任务描述" value={state().prompt} onChange={v => edit("prompt", v)} multiline />
      <Button label="创建任务" disabled={state().busy || !state().project || !state().prompt.trim()} onPress={() => void client.create()} />
      <Text style={{ fontSize: 13, color: colors.muted }}>Claude 会话从电脑原终端创建并连接后，在全部 Claude 目录中查看。</Text>
    </Scroll>;
  }
  function Settings() {
    return <Scroll style={{ flex: 1 }} contentStyle={{ gap: 16 }}>
      <Text style={{ fontSize: 24, fontWeight: "bold", color: colors.ink }}>连接与通知</Text>
      <Card><Text style={{ color: colors.ink }}>{state().pairing?.url}</Text><Text style={{ fontSize: 13, color: colors.muted }}>NSH Android · {state().pairing?.version}</Text></Card>
      <If when={state().pairing?.paired}>
        <Card><Text style={{ fontWeight: "bold", color: colors.ink }}>安卓任务通知</Text>
          <Text style={{ fontSize: 14, color: colors.muted }}>{state().notifications?.state || "读取通知状态…"}</Text>
          <Text style={{ fontSize: 13, color: colors.muted }}>权限：{state().notifications?.permission ? "已允许" : "未允许"} · 后台服务：{state().notifications?.running ? "运行中" : "未运行"}</Text>
          <Button label={state().notifications?.enabled ? "关闭任务通知" : "开启任务通知"} disabled={state().busy} onPress={() => void client.notifications(state().notifications?.enabled ? "stop" : "start")} />
          <Row><Button small label="发送测试通知" disabled={state().busy || !state().notifications?.enabled} onPress={() => void client.notifications("test")} /><Button small label="系统运行设置" onPress={() => void client.notifications("settings")} /></Row>
          <Text style={{ fontSize: 13, color: colors.muted }}>无需 Google 服务。请允许后台运行；强制停止、断网或系统省电限制可能中断通知。重启手机后请先打开应用。</Text>
        </Card>
      </If>
      <Button label={state().pairing?.pendingUnpair ? "重试解除配对" : "解除配对"} disabled={state().busy} onPress={() => void confirm("解除配对", "停止本机通知并注销本客户端，原客户端不受影响。", () => void client.unpair())} />
      <Text style={{ fontSize: 13, color: colors.muted }}>审计记录与额度面板可在原客户端查看。</Text>
    </Scroll>;
  }
  return <View style={{ flex: 1, backgroundColor: colors.paper, paddingTop: insets().top, paddingBottom: insets().bottom, paddingHorizontal: 16, gap: 12 }}>
    <Row><Button small label={state().screen === "home" ? "AgentLink" : "‹ 返回"} onPress={() => client.home()} />
      <Text style={{ flex: 1, fontSize: 12, color: colors.muted }}>{state().pairing?.paired ? state().online ? state().ws === "open" ? "实时连接" : "已连接 · 正在恢复实时" : "离线 / 待核对" : "NSH Android"}</Text>
      <If when={state().pairing?.paired}><Button small label="刷新" disabled={state().busy} onPress={() => void client.refresh()} /><Button small label="设置" onPress={() => client.screen("settings")} /></If>
    </Row>
    <If when={!!state().notice}><View style={{ padding: 10, backgroundColor: "#fff0d4", borderRadius: 8 }}><Text style={{ color: "#7d4918", fontSize: 13 }}>{state().notice}</Text></View></If>
    <If when={!state().pairing?.paired && !state().pairing?.pendingUnpair}><Pair /></If>
    <If when={state().pairing?.pendingUnpair || (state().pairing?.paired && state().screen === "settings")}><Settings /></If>
    <If when={state().pairing?.paired && state().screen === "home"}><Home /></If>
    <If when={state().pairing?.paired && state().screen === "session"}><Session /></If>
    <If when={state().pairing?.paired && state().screen === "new"}><NewTask /></If>
  </View>;
}

const inputStyle = { padding: 12, fontSize: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, borderRadius: 10, color: colors.ink };
function Field(p: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; masked?: boolean; multiline?: boolean; keyboard?: "url" }) {
  return <View style={{ gap: 7 }}><Text style={{ color: colors.muted, fontSize: 14 }}>{p.label}</Text><Input accessibilityLabel={p.label} value={p.value} onChange={({ value }) => p.onChange(value)} masked={p.masked} multiline={p.multiline} keyboardType={p.keyboard} placeholder={p.placeholder} autoCapitalize="none" autoCorrect={false} style={{ ...inputStyle, minHeight: p.multiline ? 120 : 48 }} /></View>;
}
function Button(p: { label: string; onPress: () => void; disabled?: boolean; small?: boolean }) {
  return <View role="button" accessibilityLabel={p.label} disabled={p.disabled} onPress={p.onPress} style={{ paddingVertical: p.small ? 9 : 14, paddingHorizontal: 12, borderRadius: 9, backgroundColor: p.disabled ? "#94a7a0" : p.small ? "#e1ebe6" : colors.accent }}><Text style={{ fontSize: p.small ? 13 : 16, color: p.small ? colors.ink : "#ffffff", fontWeight: "bold" }}>{p.label}</Text></View>;
}
function Row(p: { children?: JSX.Element }) { return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{p.children}</View>; }
function Card(p: { children?: JSX.Element }) { return <View style={{ backgroundColor: colors.white, padding: 14, borderRadius: 12, gap: 9 }}>{p.children}</View>; }
function History(p: { item: HistoryItem; expanded: boolean; toggle: () => void }) {
  const text = () => p.item.type === "toolCall" ? p.item.outputTail ?? "" : p.item.type === "approval" ? `${p.item.command ?? "工具审批"}\n${labels[p.item.decision]}` : p.item.text;
  return <View style={{ padding: 14, marginVertical: 5, borderRadius: 12, backgroundColor: p.item.type === "userMessage" ? "#dfebe5" : colors.white, gap: 8 }}>
    <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "bold" }}>{p.item.type === "userMessage" ? "你" : p.item.type === "agentMessage" ? "AGENT" : p.item.type === "toolCall" ? "工具" : "审批记录"}</Text>
    <If when={p.item.type === "toolCall"}><Text style={{ fontSize: 14, color: colors.ink }}>{p.item.type === "toolCall" ? `${p.item.cmd || p.item.target}\n退出码 ${p.item.exitCode ?? "—"} · ${p.item.durationMs ?? 0} ms${p.item.diffStat ? ` · +${p.item.diffStat.added} −${p.item.diffStat.removed}` : ""}` : ""}</Text></If>
    <If when={p.item.type !== "toolCall" || p.expanded}><Markdown text={p.expanded ? text() : text().slice(0, 16000)} /></If>
    <If when={p.item.type === "toolCall" || text().length > 16000}><Button small label={p.expanded ? "收起" : "展开完整内容"} onPress={p.toggle} /></If>
  </View>;
}
function Markdown(p: { text: string }) {
  return <View selectable style={{ gap: 6 }}><Each of={p.text.split(/```/)}>{(part, index) => <View style={{ gap: 5, padding: index() % 2 ? 10 : 0, backgroundColor: index() % 2 ? "#eaf0ed" : "transparent", borderRadius: 8 }}>
    <If when={index() % 2 === 1}><Text style={{ fontSize: 15, color: colors.ink }}>{part().replace(/^[a-zA-Z0-9_-]*\n/, "")}</Text></If>
    <If when={index() % 2 === 0}><Each of={part().split("\n")}>{line => <Text style={{ fontSize: /^#{1,3} /.test(line()) ? 20 : 15, fontWeight: /^(#{1,6} |\*\*)/.test(line()) ? "bold" : "normal", color: line().startsWith("> ") ? colors.muted : colors.ink }}>{line().replace(/^#{1,6} /, "").replace(/^[-*] /, "• ").replace(/^> /, "│ ").replace(/\*\*([^*]+)\*\*/g, "$1")}</Text>}</Each></If>
    <If when={index() % 2 === 1}><Button small label="复制代码" onPress={() => { void Clipboard.writeText(part().replace(/^[a-zA-Z0-9_-]*\n/, "")); }} /></If>
  </View>}</Each></View>;
}
