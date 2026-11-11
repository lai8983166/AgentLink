/** Build-time choice shared by both clients. No setting, storage key or user-facing switch. */
export type UiTheme = "classic" | "punk-collage";
export const ACTIVE_UI_THEME: UiTheme = "punk-collage";
export const isPunk = (ACTIVE_UI_THEME as string) === "punk-collage";
export const uiThemes = {
  classic: { ink: "#221c0e", paper: "#fdf9ef", primary: "#ffd700", onPrimary: "#221c0e", muted: "#6f654f", faint: "#a29877", surface: "#f8f1dd" },
  "punk-collage": { ink: "#0a0a0a", paper: "#efeae0", primary: "#e8151c", onPrimary: "#ffffff", muted: "#3b3b3b", faint: "#626262", surface: "#e8e4dc" },
} as const;
export const uiTheme = uiThemes[ACTIVE_UI_THEME];

// Adapt existing inline styles without discarding the classic definitions.
// Layout, hit targets, scroll behavior and control capabilities are untouched.
const palette: Record<string, string> = {
  "#221c0e": "#0a0a0a", "#fdf9ef": "#efeae0", "#6f654f": "#3b3b3b", "#a29877": "#626262",
  "#e7dcc0": "#bab5ac", "#f8f1dd": "#e8e4dc", "#3d5ce5": "#c41019", "#ffd700": "#ffd400",
  "#8a6e00": "#c41019", "#c4a500": "#e8151c", "#d9cdaa": "#b0aba3", "#fffdf6": "#ffffff",
  "#fff6cf": "#fff5c2", "#fffae3": "#fff5c2", "#e9edff": "#dff5ff", "#2c47c4": "#006384",
  "#d24430": "#c41019", "#1f8a3b": "#146c32", "#2fae52": "#2fd16a", "#c9bfa8": "#b5b1a9",
  "#fce9e4": "#ffe3e4", "#8a8060": "#4c4c4c", "#f1eada": "#e8e4dc",
  "#fff0a8": "#ffe8e8", "#fff1a8": "#ffe8e8", "#5a4a00": "#8f1116",
};
export function themedStyle<T>(style: T, theme: UiTheme = ACTIVE_UI_THEME): T {
  if (theme === "classic" || !style || typeof style !== "object") return style;
  if (Array.isArray(style)) return style.map(value => themedStyle(value, theme)) as T;
  const source = style as Record<string, unknown>;
  const next: Record<string, unknown> = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      next[key] = palette[value.toLowerCase()] ?? value;
      if (key === "boxShadow" && value !== "none") next[key] = "4px 4px 0 #000000";
      if (/^border(?:Top|Right|Bottom|Left)?$/.test(key)) next[key] = value.replace(/1\.5px/, "2px");
    }
    if (/^border.*Radius$/.test(key) && (typeof value === "number" || typeof value === "string")) next[key] = 0;
    if (/^border.*Width$/.test(key) && value === 1.5) next[key] = 2;
  }
  // Zine headings: tilt only text, never inputs or the content panel.
  if (source.letterSpacing === 1.26) {
    next.color = "#0a0a0a"; next.fontWeight = 700; next.transform = "rotate(-1.5deg)";
  }
  if ((source.fontSize === 16 || source.fontSize === 17 || source.fontSize === 18) && source.fontWeight === 700) next.transform = "skewX(-5deg)";
  if (source.width === 15 && source.height === 15 && source.backgroundColor === "#ffd700") next.backgroundColor = "#e8151c";
  return next as T;
}
