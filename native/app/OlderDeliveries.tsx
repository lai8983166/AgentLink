import { themedStyle } from "../../shared/src/ui-theme";
import { View } from "nsh";
import type { OutgoingMessage } from "../../web/src/message-history";
import { Text, Button, colors } from "./ui";
export function OlderDeliveries(p: { messages: OutgoingMessage[]; expanded: boolean; toggle: () => void; dismiss: () => void }) {
  return <View style={themedStyle({ marginVertical: 14, marginHorizontal: 2, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 10 })}>
    <View role="button" accessibilityLabel="展开旧发送记录" onPress={p.toggle}><Text style={themedStyle({ fontSize: 12, color: colors.muted })}>{p.expanded ? "▾" : "▸"} 已接收的旧发送记录（{p.messages.length}）</Text></View>
    <If when={p.expanded}><Text style={themedStyle({ fontSize: 12, lineHeight: 19, color: colors.muted, marginVertical: 12 })}>当前显示的历史不包含这些旧记录。接收回执表示电脑已接收，可在原会话中核对处理结果。</Text><Each of={p.messages}>{m => <View style={themedStyle({ marginVertical: 8 })}><Text style={themedStyle({ fontSize: 12, color: colors.muted })}>{new Date(m().at).toLocaleString()}</Text><Text style={themedStyle({ fontSize: 12, color: colors.muted })}>{m().text}</Text></View>}</Each><Button ghost label="清除这些本地提示" onPress={p.dismiss} /></If>
  </View>;
}
