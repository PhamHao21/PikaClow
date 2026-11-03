import chalk from "chalk";
import { BRAND_GRADIENT, glyphs, gradientText, mix, sym } from "./theme.js";
import { width } from "./text.js";

// Pixel-art wordmark. Every terminal cell shows two stacked pixels using half blocks
// (▀ ▄), which makes pixels square. The art is treated like a game sprite: a limited
// palette per letter with banded (dithered) shading, a highlight pixel on each stroke,
// a dark outline shared by all letters, a 3D drop and a couple of sparkles.

const G: Record<string, string[]> = {
  bolt: [
    "...####",
    "..####.",
    ".####..",
    "#######",
    "...###.",
    "..###..",
    ".##....",
    "#......",
  ],
  P: [
    "#####.",
    "######",
    "##..##",
    "##..##",
    "######",
    "#####.",
    "##....",
    "##....",
  ],
  I: [
    "######",
    "######",
    "..##..",
    "..##..",
    "..##..",
    "..##..",
    "######",
    "######",
  ],
  K: [
    "##...##",
    "##..##.",
    "##.##..",
    "####...",
    "####...",
    "##.##..",
    "##..##.",
    "##...##",
  ],
  A: [
    ".####.",
    "######",
    "##..##",
    "##..##",
    "######",
    "######",
    "##..##",
    "##..##",
  ],
  C: [
    ".#####",
    "######",
    "##....",
    "##....",
    "##....",
    "##....",
    "######",
    ".#####",
  ],
  L: [
    "##....",
    "##....",
    "##....",
    "##....",
    "##....",
    "##....",
    "######",
    "######",
  ],
  O: [
    ".####.",
    "######",
    "##..##",
    "##..##",
    "##..##",
    "##..##",
    "######",
    ".####.",
  ],
  W: [
    "##....##",
    "##....##",
    "##....##",
    "##.##.##",
    "##.##.##",
    "########",
    "###..###",
    "##....##",
  ],
};

const H = 8; // glyph height in pixels
const MARGIN_TOP = 2; // room for the sparkle above the bolt
const MARGIN_LEFT = 1; // room for the outline

type Kind = "face" | "drop" | "outline" | "spark" | "sparkCore";
interface Px {
  kind: Kind;
  /** Which letter (index into the ramps), for face and drop pixels. */
  letter: number;
  /** Row inside the glyph (0..H-1) for face pixels. */
  gy: number;
  x: number;
  y: number;
}

interface Bitmap {
  width: number;
  height: number;
  px: (Px | null)[][];
}

// Base colour per letter: a stepped (not smooth) walk from lemon to orange.
const LETTER_BASE = ["#FFE600", "#FFDD00", "#FFD000", "#FFC400", "#FFB700", "#FFA800", "#FF9A00", "#FF8A00"];
const BOLT_RAMP = ["#FFFFFF", "#FFFDE7", "#FFF59D", "#FFF176", "#FFEE58", "#FFE600", "#FFD600", "#FFC400"];
const OUTLINE = "#2B1700";
const SPARK = "#FFF3A0";
const SPARK_CORE = "#FFFFFF";

function ramp(base: string) {
  return {
    hi2: mix(base, "#FFFFFF", 0.72),
    hi: mix(base, "#FFFFFF", 0.4),
    base,
    lo: mix(base, "#D94A00", 0.3),
    lo2: mix(base, "#7A2800", 0.5),
    drop: mix(base, "#3A1200", 0.62),
    dropDark: mix(base, "#240A00", 0.75),
  };
}

function compose(word: string): Bitmap {
  const parts: { glyph: string[]; letter: number }[] = [{ glyph: G.bolt!, letter: -1 }];
  [...word].forEach((ch, i) => {
    const g = G[ch];
    if (g) parts.push({ glyph: g, letter: i });
  });
  // Place glyphs: one pixel between letters (filled by the shared outline), two after the bolt.
  let x = MARGIN_LEFT + 1;
  const placed = parts.map((p, i) => {
    if (i === 1) x += 1;
    const at = x;
    x += p.glyph[0]!.length + 1;
    return { ...p, x: at };
  });
  const w = x + 2;
  const h = MARGIN_TOP + H + 3;
  const px: (Px | null)[][] = Array.from({ length: h }, () => Array<Px | null>(w).fill(null));
  const set = (x: number, y: number, p: Omit<Px, "x" | "y">) => {
    if (y >= 0 && y < h && x >= 0 && x < w && !px[y]![x]) px[y]![x] = { ...p, x, y };
  };
  // 1. Faces.
  for (const p of placed) {
    p.glyph.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) {
        if (row[gx] === "#") set(p.x + gx, MARGIN_TOP + 1 + gy, { kind: "face", letter: p.letter, gy });
      }
    });
  }
  // 2. 3D drop: one pixel down-right of every face pixel.
  const faces = px.flat().filter((p): p is Px => p?.kind === "face");
  for (const f of faces) set(f.x + 1, f.y + 1, { kind: "drop", letter: f.letter, gy: f.gy });
  // 3. Outline around everything (8-neighbourhood), shared between letters.
  const solid = px.flat().filter((p): p is Px => Boolean(p));
  for (const s of solid) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) set(s.x + dx, s.y + dy, { kind: "outline", letter: -2, gy: 0 });
  }
  // 4. Sparkles: a plus-shaped twinkle over the bolt and a small one after the W.
  const spark = (cx: number, cy: number, big: boolean) => {
    set(cx, cy, { kind: "sparkCore", letter: -3, gy: 0 });
    if (big) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) set(cx + dx, cy + dy, { kind: "spark", letter: -3, gy: 0 });
  };
  spark(MARGIN_LEFT + 1, 1, true);
  spark(w - 2, MARGIN_TOP + H + 1, false);
  return { width: w, height: h, px };
}

function faceColor(p: Px): string {
  if (p.letter === -1) return BOLT_RAMP[Math.min(BOLT_RAMP.length - 1, p.gy)]!;
  const r = ramp(LETTER_BASE[p.letter % LETTER_BASE.length]!);
  const checker = (p.x + p.y) % 2 === 0;
  // Banded shading with a dithered row between bands, like hand-made pixel art.
  switch (p.gy) {
    case 0:
      return r.hi2;
    case 1:
      return r.hi;
    case 2:
      return checker ? r.hi : r.base;
    case 3:
    case 4:
      return r.base;
    case 5:
      return checker ? r.base : r.lo;
    case 6:
      return r.lo;
    default:
      return r.lo2;
  }
}

function colorOf(p: Px, bmp: Bitmap, shine: number | null): string {
  let color: string;
  switch (p.kind) {
    case "outline":
      color = OUTLINE;
      break;
    case "drop": {
      const r = p.letter === -1 ? ramp("#FFC400") : ramp(LETTER_BASE[p.letter % LETTER_BASE.length]!);
      color = p.gy >= H - 2 ? r.dropDark : r.drop;
      break;
    }
    case "spark":
      color = SPARK;
      break;
    case "sparkCore":
      color = SPARK_CORE;
      break;
    default: {
      // Specular pixel on the top-left corner of each stroke.
      const up = bmp.px[p.y - 1]?.[p.x];
      const left = bmp.px[p.y]?.[p.x - 1];
      const isCorner = p.gy <= 1 && (!up || up.kind !== "face") && (!left || left.kind !== "face");
      color = isCorner && p.letter !== -1 ? "#FFFFFF" : faceColor(p);
    }
  }
  if (shine !== null && (p.kind === "face" || p.kind === "drop")) {
    const d = Math.abs(p.x - p.y * 0.7 - shine);
    if (d < 1.6) color = mix(color, "#FFFFFF", p.kind === "face" ? 0.85 : 0.35);
  }
  return color;
}

function renderBitmap(bmp: Bitmap, shine: number | null, sparkles: boolean): string[] {
  const lines: string[] = [];
  const colored = chalk.level > 0;
  const visible = (p: Px | null): Px | null => (p && !sparkles && (p.kind === "spark" || p.kind === "sparkCore") ? null : p);
  for (let y = 0; y < bmp.height; y += 2) {
    let line = "";
    for (let x = 0; x < bmp.width; x++) {
      const top = visible(bmp.px[y]?.[x] ?? null);
      const bottom = visible(bmp.px[y + 1]?.[x] ?? null);
      if (!colored) {
        const t = top?.kind === "face";
        const b = bottom?.kind === "face";
        line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
        continue;
      }
      if (!top && !bottom) {
        line += " ";
        continue;
      }
      const tc = top ? colorOf(top, bmp, shine) : null;
      const bc = bottom ? colorOf(bottom, bmp, shine) : null;
      if (tc && bc) line += tc === bc ? chalk.hex(tc)("█") : chalk.hex(tc).bgHex(bc)("▀");
      else if (tc) line += chalk.hex(tc)("▀");
      else line += chalk.hex(bc!)("▄");
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  // Drop fully empty rows (e.g. the sparkle row when sparkles are off).
  while (lines.length && !lines[0]!.trim()) lines.shift();
  return lines;
}

const WORD = "PIKACLOW";
let cached: Bitmap | null = null;
function bitmap(): Bitmap {
  return (cached ??= compose(WORD));
}

/** Width in cells of the big logo. */
export function logoWidth(): number {
  return bitmap().width;
}

/** The big pixel logo, or null when the terminal cannot show it well. */
export function bigLogo(shine: number | null = null, sparkles = true): string[] | null {
  if (glyphs === "ascii") return null;
  return renderBitmap(bitmap(), shine, sparkles);
}

/** Shine animation positions (sweeps left → right past the end). */
export function shinePositions(): number[] {
  const w = bitmap().width;
  const steps = 18;
  return Array.from({ length: steps }, (_, i) => -6 + ((w + 12) * i) / (steps - 1));
}

/** One-line wordmark for narrow terminals and headers: "⚡ PikaClow". */
export function smallLogo(): string {
  const bolt = glyphs === "full" ? sym("bolt") + " " : "";
  return bolt + gradientText("PikaClow", BRAND_GRADIENT, true);
}

/** Centers pre-rendered lines within the given width. */
export function centerLines(lines: string[], w: number): string[] {
  const maxW = Math.max(...lines.map(width));
  const pad = Math.max(0, Math.floor((w - maxW) / 2));
  return lines.map((l) => " ".repeat(pad) + l);
}
