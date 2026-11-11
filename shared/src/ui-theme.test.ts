import { describe, expect, test } from "bun:test";
import { ACTIVE_UI_THEME, themedStyle } from "./ui-theme";

describe("build-time client themes", () => {
  test("punk is the default and classic retains the exact source styles", () => {
    expect(ACTIVE_UI_THEME).toBe("punk-collage");
    const source = { borderRadius: 14, borderWidth: 1.5, backgroundColor: "#fdf9ef", color: "#221c0e", boxShadow: "3px 3px 0 #221c0e" };
    const punk = themedStyle(source);
    expect(punk).toMatchObject({ borderRadius: 0, borderWidth: 2, backgroundColor: "#efeae0", color: "#0a0a0a" });
    expect(themedStyle(source, "classic")).toBe(source);
    expect(source.borderRadius).toBe(14);
    expect(themedStyle({ borderRadius: "22px 22px 0 0" }).borderRadius).toBe(0);
  });
  test("theme adaptation is idempotent and preserves layout and touch targets", () => {
    const styles = [{ width: 42, minHeight: 42, flex: 1, padding: 12, position: "absolute", bottom: 14 }, { borderRadius: 12, color: "#6f654f" }];
    expect(themedStyle(themedStyle(styles))).toEqual(themedStyle(styles));
    expect(themedStyle(styles)[0]).toEqual(styles[0]);
  });
  test("status semantics remain distinguishable, while no input panel gets skewed", () => {
    expect(themedStyle({ backgroundColor: "#ffd700" }).backgroundColor).toBe("#ffd400");
    expect(themedStyle({ color: "#1f8a3b" }).color).toBe("#146c32");
    expect(themedStyle({ color: "#d24430" }).color).toBe("#c41019");
    expect(themedStyle({ fontSize: 16, borderRadius: 13 })).not.toHaveProperty("transform");
  });
});
