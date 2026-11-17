import type { ITheme } from "@xterm/xterm";
import { normalizeTheme, type ThemeId } from "./model.ts";

/** Farby tém pre UI, terminál a editor. Hodnoty z forku sdesk (MIT). */

interface ThemeColors {
  /** CSS premenné na `:root` (bez `--`). */
  ui: Record<"bg" | "panel" | "panel-2" | "line" | "text" | "muted" | "accent" | "working" | "needs" | "done" | "off" | "danger" | "editor-bg", string>;
  cursor: string;
  selection: string;
  /** 16 farieb ANSI (čierna…biela, potom svetlé); bez nich ostanú predvolené z xterm.js. */
  ansi?: readonly string[];
  search: { matchBackground: string; matchOverviewRuler: string; activeMatchBackground: string; activeMatchColorOverviewRuler: string };
}

const THEMES: Record<ThemeId, ThemeColors> = {
  // Pôvodný vzhľad Project Desku; terminál si nechá predvolené farby ANSI.
  dark: {
    ui: { bg: "#111317", panel: "#16181d", "panel-2": "#1c1f26", line: "#262a33", text: "#e6e8ee", muted: "#a0a7b5", accent: "#7cc4ff",
      working: "#ffcf60", needs: "#ff6b6b", done: "#7ee2a8", off: "#4b5160", danger: "#ff6b6b", "editor-bg": "#282c34" },
    cursor: "#7cc4ff", selection: "#2d3a52",
    search: { matchBackground: "#3a4a63", matchOverviewRuler: "#7cc4ff", activeMatchBackground: "#b8860b", activeMatchColorOverviewRuler: "#ffb454" },
  },
  oled: {
    ui: { bg: "#000000", panel: "#0b0c0e", "panel-2": "#14161b", line: "#22252c", text: "#f0f2f6", muted: "#8c94a4", accent: "#60b5ff",
      working: "#ffd050", needs: "#ff5252", done: "#4ee08b", off: "#3d424d", danger: "#ff5252", "editor-bg": "#000000" },
    cursor: "#60b5ff", selection: "#223147",
    ansi: ["#000000", "#ff5252", "#4ee08b", "#ffd050", "#60b5ff", "#c770ea", "#4ed4e0", "#f0f2f6",
      "#3d424d", "#ff7575", "#70ebb0", "#ffe075", "#85c8ff", "#d990f5", "#75e5ee", "#ffffff"],
    search: { matchBackground: "#2d3f5c", matchOverviewRuler: "#60b5ff", activeMatchBackground: "#cc9400", activeMatchColorOverviewRuler: "#ffa500" },
  },
  nord: {
    ui: { bg: "#242933", panel: "#2e3440", "panel-2": "#3b4252", line: "#434c5e", text: "#eceff4", muted: "#d8dee9", accent: "#88c0d0",
      working: "#ebcb8b", needs: "#bf616a", done: "#a3be8c", off: "#4c566a", danger: "#bf616a", "editor-bg": "#242933" },
    cursor: "#88c0d0", selection: "#434c5e",
    ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#4c566a", "#d08770", "#b5d59a", "#f0d39e", "#94b3d3", "#c69dc0", "#9fd4e2", "#eceff4"],
    search: { matchBackground: "#4c566a", matchOverviewRuler: "#88c0d0", activeMatchBackground: "#d08770", activeMatchColorOverviewRuler: "#ebcb8b" },
  },
  solarized: {
    ui: { bg: "#00212b", panel: "#002b36", "panel-2": "#073642", line: "#0d4656", text: "#93a1a1", muted: "#839496", accent: "#268bd2",
      working: "#b58900", needs: "#dc322f", done: "#859900", off: "#586e75", danger: "#dc322f", "editor-bg": "#00212b" },
    cursor: "#268bd2", selection: "#073642",
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#586e75", "#cb4b16", "#99b200", "#c99a00", "#3da1e8", "#e04c96", "#3ec4b8", "#fdf6e3"],
    search: { matchBackground: "#0d4656", matchOverviewRuler: "#268bd2", activeMatchBackground: "#cb4b16", activeMatchColorOverviewRuler: "#b58900" },
  },
};

const colors = (id: string) => THEMES[normalizeTheme(id)];

const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

export function terminalTheme(id: string): ITheme {
  const c = colors(id);
  const theme: ITheme = { background: c.ui.bg, foreground: c.ui.text, cursor: c.cursor, cursorAccent: c.ui.bg, selectionBackground: c.selection };
  c.ansi?.forEach((color, i) => { theme[ANSI_KEYS[i]] = color; });
  return theme;
}

export const searchDecorations = (id: string) => colors(id).search;

/** Farby editora navrch témy oneDark; pre "dark" nič nemení. */
export function editorColors(id: string): Record<string, Record<string, string>> | null {
  if (normalizeTheme(id) === "dark") return null;
  const { ui, cursor, selection } = colors(id);
  return {
    "&": { backgroundColor: ui["editor-bg"], color: ui.text },
    ".cm-content": { caretColor: cursor },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: selection },
    ".cm-gutters": { backgroundColor: ui.panel, color: ui.muted, borderRight: `1px solid ${ui.line}` },
    ".cm-activeLine": { backgroundColor: `${ui["panel-2"]}80` },
    ".cm-activeLineGutter": { backgroundColor: ui["panel-2"], color: ui.text },
  };
}

/** Nastaví CSS premenné UI. */
export function applyUiTheme(id: string) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(colors(id).ui)) root.style.setProperty(`--${name}`, value);
}
