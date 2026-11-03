import chalk from "chalk";
import { boxChars, c, glyphs, P, sym } from "./theme.js";
import { fit, padEnd, truncate, width } from "./text.js";
import { smallLogo } from "./logo.js";
import { pixelText } from "./pixel-font.js";
import { isTTY } from "./terminal.js";

// Pixel design system. Frames are drawn with half/full blocks so their thickness is
// exactly one "pixel" (half a row tall, one column wide), corners are notched like
// pixel art, titles sit in solid tabs, meters are segmented like LEDs, and statuses
// are coloured tiles.

// ── Frames ─────────────────────────────────────────────────────────────────────
export interface BoxOptions {
  title?: string;
  /** Outer width in cells. Defaults to fitting the content. */
  width?: number;
  /** Frame colour. */
  color?: string;
  /** Title tab colour. */
  titleColor?: string;
  padding?: number;
}

/**
 * A framed panel. Every line is exactly `width` cells wide, so panels can sit side by side.
 *
 *    ▄▄▄ TITLE ▄▄▄▄▄▄▄▄
 *   █ content         █
 *    ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 */
export function box(lines: string[], opts: BoxOptions = {}): string[] {
  const pad = opts.padding ?? 1;
  const contentW = Math.max(0, ...lines.map(width), opts.title ? width(opts.title) + 4 : 0);
  const outer = opts.width ?? contentW + 2 + pad * 2;
  const inner = Math.max(1, outer - 2 - pad * 2);
  const sp = " ".repeat(pad);
  if (glyphs === "ascii") {
    const b = boxChars();
    const title = opts.title ? " " + truncate(opts.title, Math.max(1, outer - 6)) + " " : "";
    const top = b.tl + b.h + title + b.h.repeat(Math.max(0, outer - 3 - width(title))) + b.tr;
    return [top, ...lines.map((l) => b.v + sp + fit(l, inner) + sp + b.v), b.bl + b.h.repeat(Math.max(0, outer - 2)) + b.br];
  }
  const frame = (s: string) => chalk.hex(opts.color ?? P.border)(s);
  let top: string;
  if (opts.title) {
    const label = truncate(opts.title, Math.max(1, outer - 8));
    const tab = chalk.level > 0 ? chalk.bgHex(opts.titleColor ?? P.brand).hex(P.ink).bold(` ${label} `) : `[ ${label} ]`;
    top = " " + frame("▄▄") + tab + frame("▄".repeat(Math.max(0, outer - 4 - width(tab)))) + " ";
  } else {
    top = " " + frame("▄".repeat(Math.max(0, outer - 2))) + " ";
  }
  const body = lines.map((l) => frame("█") + sp + fit(l, inner) + sp + frame("█"));
  const bottom = " " + frame("▀".repeat(Math.max(0, outer - 2))) + " ";
  return [top, ...body, bottom];
}

// ── Tables ─────────────────────────────────────────────────────────────────────
export interface Column {
  header: string;
  /** Fixed width, or omitted to size from content. */
  width?: number;
  min?: number;
  align?: "left" | "right";
  /** Columns with grow share leftover space and shrink first when the terminal is narrow. */
  grow?: boolean;
}

/** A table that fits `maxWidth`, with a solid header bar. Cells may contain colors. */
export function table(columns: Column[], rows: string[][], maxWidth: number): string[] {
  const gap = 2;
  const widths = columns.map((col, i) => {
    if (col.width) return col.width;
    const content = Math.max(width(col.header), ...rows.map((r) => width(r[i] ?? "")));
    return Math.max(col.min ?? 3, content);
  });
  const total = () => widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1) + 2;
  // Shrink growable columns until it fits.
  const growable = columns.map((col, i) => (col.grow ? i : -1)).filter((i) => i >= 0);
  while (total() > maxWidth && growable.some((i) => widths[i]! > (columns[i]!.min ?? 6))) {
    const widest = growable.reduce((a, b) => (widths[b]! > widths[a]! ? b : a));
    widths[widest]!--;
  }
  const line = (cells: string[]) =>
    " " + cells.map((cell, i) => fit(cell, widths[i]!, columns[i]!.align === "right" ? "right" : "left")).join(" ".repeat(gap)) + " ";
  const head = c.headerBar(line(columns.map((col) => col.header)));
  return [head, ...rows.map((r) => line(r).replace(/\s+$/, ""))];
}

// ── Meters ─────────────────────────────────────────────────────────────────────
/** Segmented LED meter; coloured by load unless a colour is given. */
export function bar(pct: number, w: number, color?: (s: string) => string): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const paint = color ?? (p >= 85 ? c.err : p >= 60 ? c.warn : c.ok);
  // Any non-zero value lights at least one segment.
  const n = p > 0 ? Math.max(1, Math.round((p / 100) * w)) : 0;
  if (glyphs === "ascii" || chalk.level === 0) {
    const on = glyphs === "ascii" ? "#" : "█";
    const off = glyphs === "ascii" ? "-" : "░";
    return paint(on.repeat(n)) + c.faint(off.repeat(w - n));
  }
  // "▉" is 7/8 wide: the 1/8 gap separates segments like an LED bar.
  const seg = glyphs === "full" ? "▉" : "█";
  return paint(seg.repeat(n)) + chalk.hex(P.track)(seg.repeat(Math.max(0, w - n)));
}

/** Five-segment rating meter (e.g. model speed). */
export function meter(level: number, color: (s: string) => string): string {
  const n = Math.max(0, Math.min(5, Math.round(level)));
  const seg = glyphs === "full" ? "▉" : glyphs === "basic" ? "█" : "#";
  if (chalk.level === 0) return seg.repeat(n) + (glyphs === "ascii" ? "-" : "░").repeat(5 - n);
  return color(seg.repeat(n)) + chalk.hex(P.track)(seg.repeat(5 - n));
}

const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Sparkline of the last `w` values. `max` fixes the scale (e.g. 100 for percentages). */
export function sparkline(values: number[], w: number, max?: number, color?: (s: string) => string): string {
  const data = values.slice(-w);
  const top = max ?? Math.max(1, ...data);
  const chars = glyphs === "ascii" ? [" ", ".", ":", "-", "=", "+", "*", "#"] : SPARKS;
  const s = data
    .map((v) => {
      const i = Math.max(0, Math.min(7, Math.round((Math.max(0, v) / top) * 7)));
      return chars[i]!;
    })
    .join("");
  const paint = color ?? c.brand;
  return chalk.hex(P.track)((glyphs === "ascii" ? " " : "▁").repeat(Math.max(0, w - data.length))) + paint(s);
}

// ── Titles ─────────────────────────────────────────────────────────────────────
/**
 * Big pixel-font section title (3 rows) with the subtitle beside it:
 *
 *   ▄ █▀█ █▀█ █▀▄ ▀█▀ █▀
 *   ▀ █▀  █▄█ █▀▄  █  ▄█   7 listening
 */
export function titleBlock(name: string, subtitle?: string): string[] {
  if (!isTTY() || glyphs === "ascii" || chalk.level === 0) {
    return [" " + smallLogo() + c.faint(" › ") + c.bold(name) + (subtitle ? "  " + c.muted(subtitle) : "")];
  }
  const rows = pixelText(name);
  const w = Math.max(...rows.map(width));
  return rows.map((r, i) => " " + (i === 1 && subtitle ? padEnd(r, w) + "   " + c.muted(subtitle) : r));
}

// ── Status tiles ───────────────────────────────────────────────────────────────
export const status = {
  ok: (s: string) => c.tile(sym("ok"), P.ok) + " " + s,
  warn: (s: string) => c.tile(sym("warn"), P.warn) + " " + s,
  fail: (s: string) => c.tile(sym("fail"), P.err) + " " + s,
  info: (s: string) => c.tile(sym("info"), P.info) + " " + s,
  hint: (s: string) => c.brand(sym("pointer")) + " " + c.muted(s),
};

/** Inline code / command styling (a chip). */
export function cmd(s: string): string {
  return c.chip(s);
}

/** A row of keycap hints: [q] quit  [tab] view … */
export function keyHints(pairs: [string, string][]): string {
  return pairs.map(([k, label]) => c.keycap(k) + " " + c.muted(label)).join("  ");
}
