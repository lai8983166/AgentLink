import { host, signal, Text, View, Scroll, safeAreaInsets } from "nsh";
import { Input } from "nsh/base";

// This first-stage screen only exercises the Android host with synthetic input.
// It has no server configuration and cannot control a real session.
export function HostProbe() {
  const input = signal("");
  const insets = safeAreaInsets();
  const result = signal("正在连接安卓宿主…");
  const events = signal(0);
  const ready = signal(false);
  const busy = signal(false);
  host.on("probe.echoed", () => events.update((value) => value + 1));

  const call = async (name: string, data: unknown = null) => {
    if (busy()) return;
    busy.set(true);
    try {
      const value = await host.call(name, data);
      result.set(typeof value === "string" ? value : JSON.stringify(value));
    } catch {
      result.set("宿主验证失败，请重试");
    } finally {
      busy.set(false);
    }
  };

  host.call("probe.ready").then(
    () => { ready.set(true); result.set("安卓宿主已就绪"); },
    () => result.set("请在 AgentLink NSH 安卓验证包中打开"),
  );

  return (
    <Scroll style={{ flex: 1, backgroundColor: "#f5f6f8", paddingTop: insets().top, paddingBottom: insets().bottom }}>
      <View style={{ padding: 24, gap: 18 }}>
        <Text style={{ fontSize: 28, fontWeight: "bold", color: "#17202a" }}>AgentLink NSH</Text>
        <Text style={{ fontSize: 18, color: "#17202a" }}>安卓宿主验证</Text>
        <Text style={{ fontSize: 15, color: "#52606d" }}>此版本只验证输入、宿主通信和加密保存，不连接电脑后台。</Text>
        <Input accessibilityLabel="验证输入" value={input()} onChange={({ value }) => input.set(value)}
          multiline submitBehavior="newline" placeholder="输入人工测试文字"
          style={{ minHeight: 100, padding: 12, fontSize: 18, borderWidth: 1, borderColor: "#b8c4ce", borderRadius: 10 }} />
        <Text style={{ fontSize: 14, color: "#52606d" }}>输入字符：{input().length}</Text>
        <Action label="验证双向通信" enabled={ready() && !busy()} onPress={() => void call("probe.echo", input())} />
        <Action label="加密保存测试文字" enabled={ready() && !busy()} onPress={() => void call("probe.save", input())} />
        <Action label="读取测试文字" enabled={ready() && !busy()} onPress={() => void call("probe.read")} />
        <Text style={{ fontSize: 16, color: "#17202a" }}>{result()}</Text>
        <Text style={{ fontSize: 14, color: "#52606d" }}>宿主事件：{events()}</Text>
      </View>
    </Scroll>
  );
}

function Action(props: { label: string; enabled: boolean; onPress: () => void }) {
  return <View role="button" accessibilityLabel={props.label}
    onPress={() => { if (props.enabled) props.onPress(); }}
    style={{ backgroundColor: props.enabled ? "#12655b" : "#718781", padding: 14, borderRadius: 10 }}>
    <Text style={{ color: "#ffffff", fontSize: 17 }}>{props.label}</Text>
  </View>;
}
