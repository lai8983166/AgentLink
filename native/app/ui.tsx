import { Text, View, Clipboard, type JSX } from "nsh";
import { Input } from "nsh/base";
export const colors = { ink: "#221c0e", muted: "#6f654f", paper: "#fdf9ef", white: "#ffffff", accent: "#3d5ce5", line: "#e7dcc0", gold: "#ffd700", surface: "#f8f1dd" };
export const inputStyle = { padding: 12, fontSize: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, borderRadius: 10, color: colors.ink };
export function Field(p: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; masked?: boolean; multiline?: boolean; keyboard?: "url" }) {
  return <View style={{ gap: 7 }}><Text style={{ color: colors.muted, fontSize: 14 }}>{p.label}</Text><Input accessibilityLabel={p.label} value={p.value} onChange={({ value }) => p.onChange(value)} masked={p.masked} multiline={p.multiline} keyboardType={p.keyboard} placeholder={p.placeholder} autoCapitalize="none" autoCorrect={false} style={{ ...inputStyle, minHeight: p.multiline ? 120 : 48 }} /></View>;
}
export function Button(p: { label: string; onPress: () => void; disabled?: boolean; small?: boolean }) {
  return <View role="button" accessibilityLabel={p.label} disabled={p.disabled} onPress={p.onPress} style={{ paddingVertical: p.small ? 9 : 14, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1.5, borderColor: colors.ink, boxShadow: p.disabled ? "none" : "2px 2px 0 #221c0e", backgroundColor: p.disabled ? colors.surface : p.small ? colors.white : colors.gold }}><Text style={{ fontSize: p.small ? 12 : 16, color: p.disabled ? colors.muted : colors.ink, fontWeight: "bold" }}>{p.label}</Text></View>;
}
export function Row(p: { children?: JSX.Element }) { return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{p.children}</View>; }
export function Card(p: { children?: JSX.Element }) { return <View style={{ backgroundColor: colors.white, padding: 14, borderRadius: 12, borderWidth: 1.5, borderColor: colors.ink, gap: 9 }}>{p.children}</View>; }
export function Markdown(p: { text: string }) {
  return <View selectable style={{ gap: 6 }}><Each of={p.text.split(/```/)}>{(part, index) => <View style={{ gap: 5, padding: index() % 2 ? 10 : 0, backgroundColor: index() % 2 ? "#eaf0ed" : "transparent", borderRadius: 8 }}>
    <If when={index() % 2 === 1}><Text style={{ fontSize: 15, color: colors.ink }}>{part().replace(/^[a-zA-Z0-9_-]*\n/, "")}</Text></If>
    <If when={index() % 2 === 0}><Each of={part().split("\n")}>{line => <Text style={{ fontSize: /^#{1,3} /.test(line()) ? 20 : 15, fontWeight: /^(#{1,6} |\*\*)/.test(line()) ? "bold" : "normal", color: line().startsWith("> ") ? colors.muted : colors.ink }}>{line().replace(/^#{1,6} /, "").replace(/^[-*] /, "• ").replace(/^> /, "│ ").replace(/\*\*([^*]+)\*\*/g, "$1")}</Text>}</Each></If>
    <If when={index() % 2 === 1}><Button small label="复制代码" onPress={() => { void Clipboard.writeText(part().replace(/^[a-zA-Z0-9_-]*\n/, "")); }} /></If>
  </View>}</Each></View>;
}
