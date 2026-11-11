import { CollageMarks } from "./Collage";
import { themedStyle, isPunk, uiTheme } from "../../shared/src/ui-theme";
import { Text, View, List, Image, signal } from "nsh";
import { Input } from "nsh/base";
import type { Client } from "../core/client";
import { quotaLines, relativeTime, statusLabel } from "../core/presentation";
import { colors, inputStyle, fonts } from "./ui";
import { IconButton } from "./Icon";
import refreshIcon from "../assets/refresh.svg";
import settingsIcon from "../assets/settings.svg";

const faint = "#a29877";
const single = { numberOfLines: 1, textOverflow: "ellipsis" as const };
const states: Record<string, { dot: string; color: string; bg: string }> = {
  running: { dot: colors.accent, color: "#2c47c4", bg: "#e9edff" },
  waiting_approval: { dot: colors.gold, color: "#7a6200", bg: "#fff0a8" },
  done: { dot: "#2fae52", color: "#1f8a3b", bg: "#e4f4e7" },
  error: { dot: "#d24430", color: "#d24430", bg: "#fce9e4" },
  idle: { dot: "#c9bfa8", color: "#8a8060", bg: "#f1eada" },
  unknown: { dot: "transparent", color: colors.ink, bg: colors.white },
};

export function Home(p: { client: Client; state: () => Client["view"]; open: (id: string) => void }) {
  const state = p.state, client = p.client;
  const note = signal("");
  const pulling = signal(false);
  const sessions = () => (state(), client.filtered());
  const waiting = () => sessions().filter(s => s.pendingApprovals > 0);
  const active = (status: string) => status === "running" || status === "waiting_approval";
  const refresh = async () => { note.set(""); await client.refresh(true); note.set(client.view.online ? "已刷新" : "刷新失败，请重试"); };
  const pullRefresh = async () => { if (pulling()) return; pulling.set(true); try { await refresh(); } finally { pulling.set(false); } };
  function Section(q: { text: string; after?: number }) {
    return <Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 16, letterSpacing: 1.26, color: faint, marginTop: 16 - (q.after ?? 0), marginHorizontal: 4, marginBottom: 8 })}><Text style={themedStyle({ color: "#8a6e00" })}>{isPunk ? "/// " : "// "}</Text>{q.text}</Text>;
  }
  return <View style={themedStyle({ flex: 1, backgroundColor: isPunk ? "transparent" : colors.paper })}>
    <View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: colors.white, borderBottomWidth: 1.5, borderColor: colors.ink })}>
      <If when={state().agent !== "recent"}><IconButton plain name="back" label="‹ 返回" onPress={() => client.home("recent")} /></If>
      <View style={themedStyle({ flex: 1, minWidth: 0, gap: 5 })}>
        <View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 8 })}><View style={themedStyle({ width: 15, height: 15, borderRadius: 4, backgroundColor: colors.gold, borderWidth: 1.5, borderColor: colors.ink, boxShadow: "1.5px 1.5px 0 #221c0e" })} /><Text testID="home-brand" style={themedStyle({ ...single, fontFamily: fonts.sans, fontSize: 16, fontWeight: 700, lineHeight: 21, letterSpacing: -0.16, color: colors.ink, flex: 1 })}>{state().agent === "recent" ? "AgentLink" : state().agent === "codex" ? "全部 Codex 会话" : "全部 Claude Code 会话"}</Text></View>
        <View style={themedStyle({ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.ink, borderRadius: 99, paddingVertical: 3, paddingHorizontal: 10 })}><View style={themedStyle({ width: 7, height: 7, borderRadius: 4, backgroundColor: state().ws === "open" ? "#1f8a3b" : "#d24430" })} /><Text style={themedStyle({ ...single, fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 15, color: colors.muted })}>手机与后台 · {state().ws === "open" ? "已连接" : "连接中…"}{state().status?.connections ? ` · 桌面${state().status.connections.desktop === "ready" ? "已连接" : "待连接"}` : ""}</Text></View>
        <View style={themedStyle({ gap: 3 })}><Each of={quotaLines(state().status?.rateLimits, !state().online)}>{line => <Text style={themedStyle({ fontFamily: fonts.sans, fontSize: 10.5, lineHeight: 16, color: colors.muted })}>{line()}</Text>}</Each></View>
      </View>
      <View role="button" accessibilityLabel="刷新" disabled={state().refreshing} onPress={() => void refresh()} style={themedStyle(iconButton)}><Image src={refreshIcon} style={themedStyle({ width: 18, height: 18 })} /></View>
      <View role="button" accessibilityLabel="设置" onPress={() => client.screen("settings")} style={themedStyle(iconButton)}><Image src={settingsIcon} style={themedStyle({ width: 18, height: 18 })} /></View>
    </View>
    <If when={state().agent === "recent"}><View style={themedStyle({ flexDirection: "row", gap: 8, paddingVertical: 8, paddingHorizontal: 16 })}><Each of={[{ agent: "codex" as const, title: "全部 Codex 会话" }, { agent: "claude" as const, title: "全部 Claude Code 会话" }]}>{entry => <View role="button" accessibilityLabel={entry().title} onPress={() => client.home(entry().agent)} style={themedStyle({ flex: 1, height: 42, alignItems: "center", justifyContent: "center", backgroundColor: colors.white, borderRadius: 12, borderWidth: 1.5, borderColor: colors.ink, boxShadow: "3px 3px 0 #221c0e" })}><Text style={themedStyle({ ...single, fontFamily: fonts.sans, fontSize: 12, fontWeight: 700, color: colors.muted, textDecorationLine: "underline" })}>{entry().title} ›</Text></View>}</Each></View></If>
    <If when={state().agent !== "recent"}><View style={themedStyle({ paddingHorizontal: 16, paddingVertical: 8, gap: 5 })}><Input accessibilityLabel="搜索会话" placeholder="搜索标题或项目路径" value={state().query} onChange={({ value }) => { client.view.query = value; client.view.limit = 50; client.changed(); }} style={themedStyle({ ...inputStyle, paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 })} /><Text style={themedStyle({ fontFamily: fonts.sans, fontSize: 11, color: colors.muted })}>不限制活跃时间 · {sessions().length} 个会话</Text></View></If>
    <If when={state().refreshing || !!note()}><Text style={themedStyle({ fontFamily: fonts.sans, fontSize: 12, lineHeight: 28, textAlign: "center", color: colors.muted, backgroundColor: colors.surface })}>{state().refreshing ? "刷新中…" : note()}</Text></If>
    <List style={themedStyle({ flex: 1 })} contentStyle={themedStyle({ paddingHorizontal: 16 })} each={sessions().slice(0, state().limit)} keyExtractor={s => s.id} estimatedItemSize={110} onRefresh={() => void pullRefresh()} refreshing={pulling()}
      ref={list => list.scrollToOffset({ offset: state().listOffset, animated: false })} onScroll={e => { client.view.listOffset = e.offset.y; }}
      onLoadMore={() => { if (state().limit < sessions().length) { client.view.limit += 50; client.changed(); } }}
      header={() => <View style={themedStyle({ paddingTop: 12 })}><If when={state().agent === "recent"}><Section text="最近 30 天活跃" /></If><If when={waiting().length > 0}><View role="button" accessibilityLabel="查看待审批会话" onPress={() => p.open(waiting()[0]!.id)} style={themedStyle({ marginTop: 6, marginBottom: 6, paddingVertical: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10, boxShadow: "3px 3px 0 #221c0e", backgroundColor: colors.gold, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 12 })}><Text style={themedStyle({ color: colors.ink })}>⚠</Text><Text style={themedStyle({ flex: 1, fontFamily: fonts.sans, fontSize: 13, fontWeight: 700, color: colors.ink })}>{waiting().length} 个请求等待审批 · {waiting()[0]?.title}</Text><Text style={themedStyle({ fontWeight: 700 })}>›</Text></View></If></View>}
      footer={() => <View style={themedStyle({ height: 96 })} />} empty={() => <Text style={themedStyle({ padding: 24, color: colors.muted })}>{state().refreshing ? "加载中…" : state().agent === "recent" ? "最近 30 天还没有会话 · 可从上方查看全部会话" : state().query ? "没有匹配的会话" : "还没有会话"}</Text>}>
      {(item, index) => <View>
        <If when={index() === 0 || active(item().status) !== active(sessions()[index() - 1]?.status)}><Section after={index() > 0 ? 12 : waiting().length ? 6 : 0} text={active(item().status) ? "进行中" : "其他会话"} /></If>
        <View role="button" accessibilityLabel={item().title || "未命名会话"} onPress={() => p.open(item().id)} style={themedStyle({ paddingVertical: 13, paddingHorizontal: 14, marginBottom: 12, marginRight: 3, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 14, borderStyle: item().status === "idle" ? "dashed" : "solid", backgroundColor: item().status === "waiting_approval" ? "#fff6cf" : colors.white, opacity: item().status === "idle" ? 0.6 : 1, boxShadow: item().status === "idle" ? "none" : "3px 3px 0 rgba(34,28,14,0.85)" })}><CollageMarks />
          <View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 8 })}>
            <View style={themedStyle({ width: 9, height: 9, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 3, backgroundColor: states[item().status].dot })} />
            <Text testID={`title-${item().id}`} style={themedStyle({ ...single, flex: 1, minWidth: 0, fontFamily: fonts.sans, fontWeight: 700, fontSize: 15, lineHeight: 21, color: colors.ink })}><Text style={themedStyle({ color: "#c4a500", fontFamily: fonts.mono })}>#</Text>{item().forkedFromId ? "↳ " : ""}{item().title || "会话"}</Text>
            <Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 9.5, fontWeight: 700, lineHeight: 14, color: colors.muted, borderWidth: 1, borderColor: "rgba(34,28,14,0.55)", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 })}>{item().agent === "codex" ? "CODEX" : "CLAUDE"}</Text>
            <Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, lineHeight: 14, letterSpacing: 0.4, color: states[item().status].color, backgroundColor: states[item().status].bg, paddingVertical: 2, paddingHorizontal: 8, borderRadius: 99, borderWidth: 1, borderColor: "rgba(34,28,14,0.55)" })}>{statusLabel(item())}</Text>
          </View>
          <Text style={themedStyle({ ...single, marginTop: 3, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: faint })}>{item().cwd}</Text>
          <If when={!!item().preview}><View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 9 })}><Text testID={`preview-${item().id}`} style={themedStyle({ ...single, flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, color: item().status === "done" ? "#1f8a3b" : colors.muted })}>{item().preview.slice(0, 60)}</Text><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: faint })}>{relativeTime(item().lastActivityAt)}</Text></View></If>
        </View>
      </View>}
    </List>
    <View role="button" accessibilityLabel="新建任务" onPress={() => client.openNew()} style={themedStyle({ position: "absolute", bottom: 34, right: 18, width: 56, height: 56, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: uiTheme.primary, borderWidth: 2, borderColor: colors.ink, boxShadow: "4px 4px 0 #221c0e" })}><View style={themedStyle({ width: 20, height: 4, backgroundColor: uiTheme.onPrimary })} /><View style={themedStyle({ position: "absolute", width: 4, height: 20, backgroundColor: uiTheme.onPrimary })} /></View>
  </View>;
}

const iconButton = { width: 34, height: 34, borderRadius: 10, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.ink, boxShadow: "2px 2px 0 #221c0e" };
