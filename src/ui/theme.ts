import chalk from "chalk";
import { graphemes } from "./text.js";

// ── Glyph support ──────────────────────────────────────────────────────────────
// "full"  modern terminals (Windows Terminal, VS Code, macOS, Linux emulators)
// "basic" legacy Windows console: box drawing and blocks only, no emoji
// "ascii" anything else, or forced with PIKACLOW_ASCII=1
export type GlyphLevel = "full" | "basic" | "ascii";

function detectGlyphs(): GlyphLevel {
  const env = process.env;
  const forced = env.PIKACLOW_GLYPHS;
  if (forced === "full" || forced === "basic" || forced === "ascii") return forced;
  if (env.PIKACLOW_ASCII === "1") return "ascii";
  if (process.platform !== "win32") return env.TERM === "linux" ? "basic" : "full";
  const modern =
    env.WT_SESSION ||
    env.TERM_PROGRAM ||
    env.ConEmuTask ||
    env.WEZTERM_EXECUTABLE ||
    env.ALACRITTY_LOG ||
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm" ||
    env.TERM?.startsWith("xterm") ||
    env.CI;
  return modern ? "full" : "basic";
}

export let glyphs: GlyphLevel = detectGlyphs();
export function setGlyphs(level: GlyphLevel): void {
  glyphs = level;
}

const SYMBOLS = {
  full: {
    ok: "✔", fail: "✖", warn: "!", info: "i", bullet: "■", pointer: "►", pointerSmall: "›",
    diamond: "■", diamondOpen: "□", bar: "▌", barEnd: "▀", dot: "■", circle: "□",
    checkOn: "■", checkOff: "□", radioOn: "■", radioOff: "□", bolt: "⚡", branch: "⎇",
    ellipsis: "…", up: "↑", down: "↓", left: "←", right: "→", enter: "↵", dash: "─",
  },
  basic: {
    ok: "√", fail: "×", warn: "!", info: "i", bullet: "■", pointer: "►", pointerSmall: ">",
    diamond: "■", diamondOpen: "□", bar: "▌", barEnd: "▀", dot: "■", circle: "□",
    checkOn: "■", checkOff: "□", radioOn: "■", radioOff: "□", bolt: "»", branch: "git:",
    ellipsis: "…", up: "↑", down: "↓", left: "←", right: "→", enter: "Enter", dash: "─",
  },
  ascii: {
    ok: "+", fail: "x", warn: "!", info: "*", bullet: "*", pointer: ">", pointerSmall: ">",
    diamond: "*", diamondOpen: "o", bar: "|", barEnd: "`", dot: "*", circle: "o",
    checkOn: "[x]", checkOff: "[ ]", radioOn: "(*)", radioOff: "( )", bolt: ">>", branch: "git:",
    ellipsis: "...", up: "^", down: "v", left: "<", right: ">", enter: "Enter", dash: "-",
  },
} as const;

export type SymbolName = keyof (typeof SYMBOLS)["full"];
export function sym(name: SymbolName): string {
  return SYMBOLS[glyphs][name];
}

const BOXES = {
  full: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", tT: "┬", tB: "┴", tL: "├", tR: "┤", x: "┼" },
  basic: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", tT: "┬", tB: "┴", tL: "├", tR: "┤", x: "┼" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", tT: "+", tB: "+", tL: "+", tR: "+", x: "+" },
} as const;

export function boxChars() {
  return BOXES[glyphs];
}

// ── Colors ─────────────────────────────────────────────────────────────────────
export type ThemeName = "dark" | "light";

const THEMES = {
  dark: {
    brand: "#FFD60A", brandSoft: "#FFE873", amber: "#FFB020", orange: "#FF8A1F",
    ok: "#5BE08D", warn: "#FFB020", err: "#FF5F57", info: "#5CC8FF",
    muted: "#8C8C8C", faint: "#595959", track: "#3A3A3A", selectBg: "#3B3000", border: "#8A6A12",
    ink: "#1A1300", panel: "#2D2D2D", headerBg: "#2E2500", shadow: "#0A0A0A", segA: "#3A3A3A", segB: "#4A3B00", frame: "#D1A000",
  },
  light: {
    brand: "#9A6B00", brandSoft: "#7A5500", amber: "#A86400", orange: "#B84E00",
    ok: "#0F8A3C", warn: "#A86400", err: "#C62828", info: "#0969DA",
    muted: "#6E6E6E", faint: "#A6A6A6", track: "#DADADA", selectBg: "#FFF1B8", border: "#C9A227",
    ink: "#1A1300", panel: "#E4E4E4", headerBg: "#FFF0B3", shadow: "#B5B5B5", segA: "#E0E0E0", segB: "#FFE38A", frame: "#B58100",
  },
} as const;

export type Palette = { [K in keyof (typeof THEMES)["dark"]]: string };

function detectTheme(): ThemeName {
  const env = process.env.PIKACLOW_THEME;
  if (env === "light" || env === "dark") return env;
  // COLORFGBG is "fg;bg" (set by some terminals); a bright background means a light theme.
  const bg = Number(process.env.COLORFGBG?.split(";").pop());
  if (Number.isFinite(bg) && (bg === 7 || bg === 15)) return "light";
  return "dark";
}

export let themeName: ThemeName = detectTheme();
export let P: Palette = THEMES[themeName];

export function setTheme(name: ThemeName): void {
  themeName = name;
  P = THEMES[name];
}

/** Semantic color helpers. They read the palette at call time, so theme switches apply. */
export const c = {
  brand: (s: string) => chalk.hex(P.brand)(s),
  brandBold: (s: string) => chalk.bold.hex(P.brand)(s),
  soft: (s: string) => chalk.hex(P.brandSoft)(s),
  amber: (s: string) => chalk.hex(P.amber)(s),
  orange: (s: string) => chalk.hex(P.orange)(s),
  ok: (s: string) => chalk.hex(P.ok)(s),
  warn: (s: string) => chalk.hex(P.warn)(s),
  err: (s: string) => chalk.hex(P.err)(s),
  info: (s: string) => chalk.hex(P.info)(s),
  muted: (s: string) => chalk.hex(P.muted)(s),
  faint: (s: string) => chalk.hex(P.faint)(s),
  border: (s: string) => chalk.hex(P.border)(s),
  bold: (s: string) => chalk.bold(s),
  dim: (s: string) => chalk.dim(s),
  italic: (s: string) => chalk.italic(s),
  underline: (s: string) => chalk.underline(s),
  inverse: (s: string) => chalk.inverse(s),
  selected: (s: string) => chalk.bgHex(P.selectBg).hex(P.brand)(s),
  hex: (color: string, s: string) => chalk.hex(color)(s),
  /** Solid colour tile with dark text: " OK ", " ✔ ". Pixel-style badge. */
  tile: (text: string, color: string = P.brand) => (chalk.level > 0 ? chalk.bgHex(color).hex(P.ink).bold(` ${text} `) : `[${text}]`),
  /** Keyboard key drawn as a keycap. */
  keycap: (key: string) => (chalk.level > 0 ? chalk.bgHex(P.panel).hex(P.brand).bold(` ${key} `) : `[${key}]`),
  /** Inline code / command chip. */
  chip: (text: string) => (chalk.level > 0 ? chalk.bgHex(P.panel).hex(P.brandSoft)(` ${text} `) : text),
  /** Table header / title bar background. */
  headerBar: (text: string) => chalk.bgHex(P.headerBg).hex(P.brand).bold(text),
  /** Status-bar segment. */
  seg: (text: string, bg: string, fg: string = P.muted) => (chalk.level > 0 ? chalk.bgHex(bg).hex(fg)(` ${text} `) : ` ${text} `),
};

/** Color for a 0–100 load value: calm → busy → hot. */
export function levelColor(pct: number): (s: string) => string {
  if (pct >= 85) return c.err;
  if (pct >= 60) return c.warn;
  return c.ok;
}

// ── Gradients ──────────────────────────────────────────────────────────────────
export const BRAND_GRADIENT = ["#FFF3A3", "#FFE14D", "#FFC400", "#FFA000", "#FF7A00"];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

/** Linear blend: t=0 → a, t=1 → b. */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

export const lighten = (hex: string, t: number) => mix(hex, "#FFFFFF", t);
export const darken = (hex: string, t: number) => mix(hex, "#000000", t);

/** Color at position t (0..1) along a multi-stop gradient. */
export function gradientAt(stops: readonly string[], t: number): string {
  if (stops.length === 0) return "#FFFFFF";
  if (stops.length === 1) return stops[0]!;
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i]!, stops[i + 1]!, x - i);
}

/** Paints each character of plain text along a gradient. */
export function gradientText(text: string, stops: readonly string[] = BRAND_GRADIENT, bold = false): string {
  if (chalk.level === 0) return text;
  const chars = graphemes(text);
  const n = Math.max(1, chars.length - 1);
  const paint = bold ? chalk.bold : chalk;
  return chars.map((ch, i) => (ch === " " ? ch : paint.hex(gradientAt(stops, i / n))(ch))).join("");
}
