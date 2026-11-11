import { Image, View } from "nsh";
import { isPunk } from "../../shared/src/ui-theme";
import cut from "../assets/punk-cut.svg";
import dots from "../assets/punk-dots.svg";
import paper from "../assets/punk-paper.svg";

export function CollagePaper() {
  return <If when={isPunk}><Image src={paper} style={{ pointerEvents: "none", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "fill" }} /></If>;
}

/** Static paper marks. Never rotate a scroll container or cover a hit target. */
export function CollageMarks() {
  return <If when={isPunk}><View style={{ pointerEvents: "none", position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
    <Image src={cut} style={{ position: "absolute", top: -2, right: -2, width: 14, height: 14 }} />
    <Image src={dots} style={{ position: "absolute", top: 2, right: 18, width: 70, height: 14, opacity: 0.5 }} />
  </View></If>;
}
export function CollageSlash() {
  return <If when={isPunk}><View style={{ pointerEvents: "none", position: "absolute", top: 5, right: 14, width: 36, height: 5, backgroundColor: "#e8151c", transform: "skewX(-25deg)" }} /></If>;
}
