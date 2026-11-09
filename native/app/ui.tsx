import { Text as NativeText, View, Clipboard, type JSX, type TextProps } from "nsh";
import { Input } from "nsh/base";
import sans from "../assets/fonts/SpaceGrotesk-Regular.ttf";
import sansBold from "../assets/fonts/SpaceGrotesk-Bold.ttf";
import mono from "../assets/fonts/SpaceMono-Regular.ttf";
import monoBold from "../assets/fonts/SpaceMono-Bold.ttf";
// Explicit imports register the real faces before rendering, including the bold mono face.
export const fonts = { sans: `${sans}, ${sansBold}, sans-serif`, mono: `${mono}, ${monoBold}, monospace` };
export const colors = { ink: "#221c0e", muted: "#6f654f", paper: "#fdf9ef", white: "#ffffff", accent: "#3d5ce5", line: "#e7dcc0", gold: "#ffd700", surface: "#f8f1dd" };
export function Text(p: TextProps) { return <NativeText {...p} style={[{ fontFamily: fonts.sans }, p.style]}>{p.children}</NativeText>; }
export const inputStyle = { padding: 12, fontFamily: fonts.sans, fontSize: 16, lineHeight: 25.6, borderWidth: 1.5, borderColor: colors.ink, backgroundColor: colors.white, borderRadius: 13, color: colors.ink };
export function Section(p: { label: string; first?: boolean }) { return <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 16, letterSpacing: 1.26, color: "#a29877", marginTop: p.first ? 0 : 16, marginHorizontal: 4, marginBottom: 8 }}><Text style={{ color: "#8a6e00" }}>// </Text>{p.label}</Text>; }
export function Field(p: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; masked?: boolean; multiline?: boolean; keyboard?: "url" }) {
  return <View style={{ gap: 7 }}><Text style={{ color: colors.muted, fontSize: 14 }}>{p.label}</Text><Input accessibilityLabel={p.label} value={p.value} onChange={({ value }) => p.onChange(value)} masked={p.masked} multiline={p.multiline} keyboardType={p.keyboard} placeholder={p.placeholder} autoCapitalize="none" autoCorrect={false} style={{ ...inputStyle, minHeight: p.multiline ? 120 : 48 }} /></View>;
}
export function Button(p: { label: string; onPress: () => void; disabled?: boolean; small?: boolean }) {
  return <View role="button" accessibilityLabel={p.label} disabled={p.disabled} onPress={p.onPress} style={{ minHeight: p.small ? 32 : 42, paddingVertical: p.small ? 5 : 9, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderRadius: p.small ? 9 : 12, borderWidth: 1.5, borderColor: colors.ink, boxShadow: p.disabled ? "none" : p.small ? "2px 2px 0 #221c0e" : "3px 3px 0 #221c0e", backgroundColor: p.disabled ? colors.surface : p.small ? colors.white : colors.gold }}><Text style={{ fontSize: p.small ? 12 : 14, lineHeight: 20, color: p.disabled || p.small ? colors.muted : colors.ink, fontWeight: 700 }}>{p.label}</Text></View>;
}
export function Row(p: { children?: JSX.Element }) { return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{p.children}</View>; }
export function Card(p: { children?: JSX.Element }) { return <View style={{ backgroundColor: colors.white, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1.5, borderColor: colors.ink, boxShadow: "3px 3px 0 rgba(34,28,14,0.85)", marginBottom: 12, marginRight: 3, gap: 9 }}>{p.children}</View>; }
export function Markdown(p: { text: string }) {
  return <View selectable style={{ gap: 6 }}><Each of={p.text.split(/```/)}>{(part, index) => <View style={{ gap: 5, padding: index() % 2 ? 10 : 0, backgroundColor: index() % 2 ? "#eaf0ed" : "transparent", borderRadius: 8 }}>
    <If when={index() % 2 === 1}><Text style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 19.2, color: colors.ink }}>{part().replace(/^[a-zA-Z0-9_-]*\n/, "")}</Text></If>
    <If when={index() % 2 === 0}><Each of={part().split("\n")}>{line => <Text style={{ fontSize: /^#{1,3} /.test(line()) ? 18 : 14, lineHeight: 24.5, fontWeight: /^(#{1,6} |\*\*)/.test(line()) ? 700 : 400, color: line().startsWith("> ") ? colors.muted : colors.ink }}>{line().replace(/^#{1,6} /, "").replace(/^[-*] /, "• ").replace(/^> /, "│ ").replace(/\*\*([^*]+)\*\*/g, "$1")}</Text>}</Each></If>
    <If when={index() % 2 === 1}><Button small label="复制代码" onPress={() => { void Clipboard.writeText(part().replace(/^[a-zA-Z0-9_-]*\n/, "")); }} /></If>
  </View>}</Each></View>;
}
