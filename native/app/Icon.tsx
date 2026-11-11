import punkSend from "../assets/punk-send.svg";
import { themedStyle, isPunk } from "../../shared/src/ui-theme";
import { Image, View } from "nsh";
import back from "../assets/back.svg";
import close from "../assets/close.svg";
import send from "../assets/send.svg";
import stop from "../assets/stop.svg";
import folder from "../assets/folder.svg";
import bolt from "../assets/bolt.svg";
import house from "../assets/house.svg";
import network from "../assets/network.svg";
import audit from "../assets/audit.svg";
import chevron from "../assets/chevron.svg";
import terminal from "../assets/terminal.svg";
import file from "../assets/file.svg";
import { colors } from "./ui";
const icons = { back, close, send, stop, folder, bolt, house, network, audit, chevron, terminal, file };
export function Icon(p: { name: keyof typeof icons; size?: number }) { return <Image src={isPunk && p.name === "send" ? punkSend : icons[p.name]} style={themedStyle({ width: p.size ?? 18, height: p.size ?? 18 })} />; }
export function IconButton(p: { name: keyof typeof icons; label: string; onPress: () => void; disabled?: boolean; plain?: boolean }) {
  return <View role="button" accessibilityLabel={p.label} disabled={p.disabled} onPress={p.onPress} style={themedStyle({ width: p.plain ? 28 : 34, height: p.plain ? 30 : 34, marginLeft: p.plain ? -8 : 0, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: p.plain ? 0 : 1.5, borderColor: colors.ink, backgroundColor: p.plain ? "transparent" : colors.white, opacity: p.disabled ? 0.5 : 1, boxShadow: p.plain ? "none" : "2px 2px 0 #221c0e" })}><Icon name={p.name} /></View>;
}
