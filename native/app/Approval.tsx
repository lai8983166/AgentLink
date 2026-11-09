import { View } from "nsh";
import type { PendingApprovalSnapshot } from "../../shared/src/domain";
import { decisions } from "../core/client";
import { Text, Button, colors, fonts } from "./ui";
export function ResolvedApproval(p: { command?: string | null; decision: string }) {
  const labels: Record<string, string> = { expired: "已作废（轮次结束）", resolved_elsewhere: "已在电脑端处理或已作废", accept: "✓ 已批准", acceptForSession: "✓ 已批准 · 本会话同类自动通过", decline: "✕ 已拒绝 · agent 另想办法", cancel: "✕ 已拒绝并中断" };
  return <View style={{ marginTop: 14, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.ink, borderRadius: 16, backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 14 }}><Text style={{ fontSize: 12.5, fontWeight: 550, color: p.decision.startsWith("accept") ? "#1f8a3b" : p.decision === "expired" ? "#a29877" : "#d24430" }}>{p.command || "文件改动"} — {labels[p.decision] || p.decision}</Text></View>;
}
export function Approval(p: { value: PendingApprovalSnapshot; allowed: boolean; decide: (decision: string) => void }) {
  const available = () => decisions(p.value.availableDecisions);
  return <View style={{ marginTop: 14, marginRight: 4, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 16, backgroundColor: "#fffae3", boxShadow: "4px 4px 0 #221c0e", paddingVertical: 13, paddingHorizontal: 14 }}>
    <Text style={{ fontSize: 13, fontWeight: 700, color: "#8a6e00" }}>⚠ {p.value.kind === "command" ? "请求执行命令" : "请求修改文件"}</Text>
    <If when={!!p.value.command}><Text style={{ fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 18.75, paddingVertical: 10, paddingHorizontal: 11, marginTop: 10, backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 9 }}>{p.value.command}</Text></If>
    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: "#a29877", marginTop: 7 }}>{p.value.cwd}</Text>
    <If when={p.value.command?.includes("rm ")}><Text style={{ fontSize: 11.5, color: "#d24430", marginTop: 8 }}>⚠ 含删除操作 · 请确认</Text></If>
    <If when={!!p.value.reason}><Text style={{ fontSize: 12, lineHeight: 19.2, color: colors.muted, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderStyle: "dotted", borderColor: "#cbbe97" }}>Agent 说明：{p.value.reason}</Text></If>
    <View style={{ flexDirection: "row", gap: 9, marginTop: 13 }}><If when={available().includes("decline") || available().includes("cancel")}><View style={{ flex: 1 }}><Button ghost label={available().includes("decline") ? "拒绝" : "拒绝并中断"} disabled={!p.allowed} onPress={() => p.decide(available().includes("decline") ? "decline" : "cancel")} /></View></If><If when={available().includes("accept")}><View style={{ flex: 1 }}><Button label="批准" disabled={!p.allowed} onPress={() => p.decide("accept")} /></View></If></View>
    <If when={available().includes("acceptForSession")}><View role="button" accessibilityLabel="批准（本会话不再询问）" disabled={!p.allowed} onPress={() => p.decide("acceptForSession")} style={{ marginTop: 11 }}><Text style={{ textAlign: "center", fontFamily: fonts.mono, fontSize: 11.5, color: colors.muted, textDecorationLine: "underline" }}>批准，且本会话内不再询问此类操作</Text></View></If>
    <If when={!available().length}><Text style={{ fontSize: 12, color: colors.muted }}>此审批类型请回电脑端处理。</Text></If>
  </View>;
}
