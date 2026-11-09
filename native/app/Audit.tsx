import { Scroll, View } from "nsh";
import type { Client } from "../core/client";
import { Text, Card, Button, colors, fonts } from "./ui";
const labels: Record<string, string> = { accept: "批准", acceptForSession: "批准（本会话）", decline: "拒绝", cancel: "拒绝并中断" };
export function Audit(p: { client: Client; state: () => Client["view"] }) {
  const s = p.state;
  return <Scroll style={{ flex: 1, backgroundColor: colors.paper }} contentStyle={{ padding: 16, paddingTop: 12, paddingBottom: 32 }}><Card>
    <If when={!s().audit.length}><Text style={{ padding: 24, textAlign: "center", fontSize: 13, color: colors.muted }}>{s().busy ? "加载中…" : s().auditLoaded ? "还没有审批记录" : "读取失败，请重试"}</Text></If>
    <Each of={s().audit}>{a => <View style={{ paddingVertical: 12, borderBottomWidth: 1, borderStyle: "dotted", borderColor: "#dacfaf" }}><View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={{ fontSize: 13, fontWeight: 700, color: a().decision.startsWith("accept") ? "#1f8a3b" : "#d24430" }}>{labels[a().decision] || a().decision}</Text><Text style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, numberOfLines: 1, textOverflow: "ellipsis" }}>{a().project.split(/[\\/]/).pop()}</Text><Text style={{ fontFamily: fonts.mono, fontSize: 11, color: "#a29877" }}>{new Date(a().at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</Text></View><If when={!!a().command}><Text style={{ fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 18.4, color: colors.muted, backgroundColor: colors.surface, borderWidth: 1, borderStyle: "dashed", borderColor: "#d9cdaa", borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8, marginTop: 7 }}>{a().command}</Text></If></View>}</Each>
    <If when={s().auditCursor !== null}><View role="button" accessibilityLabel="加载更多" disabled={s().busy} onPress={() => void p.client.loadAudit()} style={{ paddingVertical: 12 }}><Text style={{ textAlign: "center", fontSize: 13, color: colors.muted, textDecorationLine: "underline" }}>{s().busy ? "加载中…" : "加载更多"}</Text></View></If>
    <If when={!s().busy && !s().auditLoaded}><Button ghost label="重试读取审计日志" onPress={() => void p.client.loadAudit(true)} /></If>
  </Card></Scroll>;
}
