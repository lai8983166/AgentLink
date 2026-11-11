import { CollageMarks } from "./Collage";
import { themedStyle, isPunk, uiTheme } from "../../shared/src/ui-theme";
import { Text as NativeText, View, Clipboard, type JSX, type TextProps } from "nsh";
import { Input } from "nsh/base";
import sans from "../assets/fonts/SpaceGrotesk-Regular.ttf";
import sansMedium from "../assets/fonts/SpaceGrotesk-Medium.ttf";
import sansBold from "../assets/fonts/SpaceGrotesk-Bold.ttf";
import mono from "../assets/fonts/SpaceMono-Regular.ttf";
import monoBold from "../assets/fonts/SpaceMono-Bold.ttf";
// Explicit imports register the real faces before rendering, including the bold mono face.
export const fonts = { sans: `${sans}, ${sansMedium}, ${sansBold}, sans-serif`, mono: `${mono}, ${monoBold}, monospace` };
export const colors = { ink: "#221c0e", muted: "#6f654f", paper: "#fdf9ef", white: "#ffffff", accent: "#3d5ce5", line: "#e7dcc0", gold: "#ffd700", surface: "#f8f1dd" };
export function Text(p: TextProps) { return <NativeText {...p} style={themedStyle([{ fontFamily: fonts.sans, color: colors.ink }, p.style])}>{p.children}</NativeText>; }
export const inputStyle = { padding: 12, fontFamily: fonts.sans, fontSize: 16, lineHeight: 25.6, borderWidth: 1.5, borderColor: colors.ink, backgroundColor: colors.white, borderRadius: 13, color: colors.ink };
export function Section(p: { label: string; first?: boolean; note?: string; after?: number }) { return <Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 16, letterSpacing: 1.26, color: "#a29877", marginTop: p.first ? 0 : 16 - (p.after ?? 0), marginHorizontal: 4, marginBottom: 8 })}><NativeText style={themedStyle({ color: "#8a6e00" })}>{isPunk ? "/// " : "// "}</NativeText>{p.label}<If when={!!p.note}><NativeText style={themedStyle({ fontFamily: fonts.sans, fontSize: 9, letterSpacing: 0, fontWeight: 400 })}>　{p.note}</NativeText></If></Text>; }
export function Field(p: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; masked?: boolean; multiline?: boolean; keyboard?: "url" }) {
  return <View style={themedStyle({ gap: 7 })}><Text style={themedStyle({ color: colors.muted, fontSize: 14 })}>{p.label}</Text><Input accessibilityLabel={p.label} value={p.value} onChange={({ value }) => p.onChange(value)} masked={p.masked} multiline={p.multiline} keyboardType={p.keyboard} placeholder={p.placeholder} autoCapitalize="none" autoCorrect={false} style={themedStyle({ ...inputStyle, minHeight: p.multiline ? 120 : 48 })} /></View>;
}
export function Button(p: { label: string; onPress: () => void; disabled?: boolean; small?: boolean; ghost?: boolean; primary?: boolean }) {
  const ghost = () => p.ghost || (p.small && !p.primary);
  return <View role="button" accessibilityLabel={p.label} disabled={p.disabled} onPress={p.onPress} style={themedStyle({ minHeight: p.small ? 32 : 42, paddingVertical: p.small ? 5 : 9, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderRadius: p.small ? 9 : 12, borderWidth: 1.5, borderColor: colors.ink, boxShadow: p.small ? "2px 2px 0 #221c0e" : "3px 3px 0 #221c0e", backgroundColor: ghost() ? colors.white : uiTheme.primary, opacity: p.disabled && isPunk ? 0.55 : 1 })}><Text style={themedStyle({ fontSize: p.small ? 12.5 : 14, lineHeight: 20, color: ghost() ? colors.muted : uiTheme.onPrimary, fontWeight: 700 })}>{p.label}</Text></View>;
}
export function Row(p: { children?: JSX.Element }) { return <View style={themedStyle({ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" })}>{p.children}</View>; }
export function Card(p: { children?: JSX.Element; gap?: number }) { return <View style={themedStyle({ backgroundColor: colors.white, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1.5, borderColor: colors.ink, boxShadow: "3px 3px 0 rgba(34,28,14,0.85)", marginBottom: 12, marginRight: 3, gap: p.gap ?? 0 })}><CollageMarks />{p.children}</View>; }
export function Markdown(p: { text: string }) {
  return <View selectable><Each of={p.text.split(/```/)}>{(part, index) => <View>
    <If when={index() % 2 === 1}><View accessibilityLabel="长按复制代码" onLongPress={() => void Clipboard.writeText(part().replace(/^[a-zA-Z0-9_-]*\n/, ""))} style={themedStyle({ paddingVertical: 9, paddingHorizontal: 10, backgroundColor: colors.surface, borderWidth: 1, borderStyle: "dashed", borderColor: "#d9cdaa", borderRadius: 8, marginVertical: 8 })}><Text style={themedStyle({ fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 18.4, color: colors.ink })}>{part().replace(/^[a-zA-Z0-9_-]*\n/, "")}</Text></View></If>
    <If when={index() % 2 === 0}><Text style={themedStyle({ fontSize: 14, lineHeight: 24.5, color: colors.ink })}><Each of={part().split(/`([^`]+)`/g)}>{(segment, n) => <NativeText style={themedStyle(n() % 2 ? { fontFamily: fonts.mono, fontSize: 12, color: "#5a4a00", backgroundColor: "#fff1a8", borderWidth: 1, borderColor: "#e9da82", borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 } : {})}>{segment()}</NativeText>}</Each></Text></If>
  </View>}</Each></View>;
}
