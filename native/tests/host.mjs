// Synthetic host for headless UI tests only. Does not emulate Android Keystore.
export async function createHost(player) {
  let saved = null;
  return {
    call(name, value) {
      if (name === "probe.ready") return true;
      if (name === "probe.echo") {
        player.hostEvent("probe.echoed", null);
        return value;
      }
      if (name === "probe.save") {
        if (value.length > 8192) throw new Error("Invalid probe text");
        saved = value;
        return "测试文字已加密保存";
      }
      if (name === "probe.read") return saved ?? "尚未保存测试文字";
      throw new Error("Unknown probe operation");
    },
  };
}
