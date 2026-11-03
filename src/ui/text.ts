import stringWidth from "fast-string-width";
import truncatedWidth from "fast-string-truncated-width";
import { wrapAnsi } from "fast-wrap-ansi";

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visible width in terminal cells (ANSI-, emoji- and CJK-aware). */
export function width(s: string): number {
  return stringWidth(s);
}

/** Cuts a (possibly colored) string to at most `max` cells, adding an ellipsis when cut. */
export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  const r = truncatedWidth(s, { limit: max, ellipsis });
  if (!r.truncated) return s;
  const reset = s.includes("\x1b") ? "\x1b[0m" : "";
  return s.slice(0, r.index) + reset + (r.ellipsed ? ellipsis : "");
}

/** Truncates from the left: "…/deep/path/file.ts". */
export function truncateStart(s: string, max: number, ellipsis = "…"): string {
  if (width(s) <= max) return s;
  const chars = [...s];
  let out = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = chars[i] + out;
    if (width(next) + width(ellipsis) > max) break;
    out = next;
  }
  return ellipsis + out;
}

export function padEnd(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - width(s)));
}

export function padStart(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - width(s))) + s;
}

/** Truncate then pad, so the result is exactly `w` cells. */
export function fit(s: string, w: number, align: "left" | "right" | "center" = "left"): string {
  const t = truncate(s, w);
  if (align === "right") return padStart(t, w);
  if (align === "center") return center(t, w);
  return padEnd(t, w);
}

export function center(s: string, w: number): string {
  const free = Math.max(0, w - width(s));
  const left = Math.floor(free / 2);
  return " ".repeat(left) + s + " ".repeat(free - left);
}

/** Word-wraps (hard-breaking long words) and returns the lines. */
export function wrap(s: string, w: number): string[] {
  if (w <= 0) return [s];
  return wrapAnsi(s, w, { hard: true, trim: false })
    .split("\n")
    .map((l) => l.replace(/ +$/, ""));
}

/** Splits text into grapheme clusters (so "ế" or an emoji is one unit). */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment);
}
