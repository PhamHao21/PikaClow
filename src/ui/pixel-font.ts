import chalk from "chalk";
import { mix } from "./theme.js";

// A tiny 3×5 pixel font for section titles ("PORTS", "CLEAN"…), drawn with half
// blocks so each pixel is square. Titles get the same treatment as the logo:
// banded shading and a 1-pixel drop shadow.

const FONT: Record<string, string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "0": [".#.", "#.#", "#.#", "#.#", ".#."],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["##.", "..#", ".#.", "..#", "##."],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "##.", "#.#", ".#."],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": [".#.", "#.#", ".#.", "#.#", ".#."],
  "9": [".#.", "#.#", ".##", "..#", "##."],
  "-": ["...", "...", "###", "...", "..."],
  "!": ["#", "#", "#", ".", "#"],
  "?": ["##.", "..#", ".#.", "...", ".#."],
  ".": [".", ".", ".", ".", "#"],
  " ": ["..", "..", "..", "..", ".."],
  // Tiny lightning bolt used in front of titles.
  "⚡": ["..#", ".#.", "###", ".#.", "#.."],
};

const TITLE_BASE = ["#FFE600", "#FFD400", "#FFC200", "#FFB000", "#FF9E00", "#FF8C00"];

type Cell = { kind: "face" | "drop"; color: string } | null;

/**
 * Renders text in the tiny pixel font. Returns 3 terminal rows
 * (5 pixel rows + 1 shadow row, two pixels per row).
 */
export function pixelText(text: string, withBolt = true): string[] {
  const chars = [...(withBolt ? "⚡ " : "") + text.toUpperCase()].filter((ch) => FONT[ch]);
  const glyphs = chars.map((ch) => FONT[ch]!);
  const w = glyphs.reduce((a, g) => a + g[0]!.length + 1, 0) + 1;
  const h = 6;
  const grid: Cell[][] = Array.from({ length: h }, () => Array<Cell>(w).fill(null));
  let x = 0;
  let letter = 0;
  glyphs.forEach((g, i) => {
    const isBolt = withBolt && i === 0;
    const base = isBolt ? "#FFF176" : TITLE_BASE[Math.min(TITLE_BASE.length - 1, letter)]!;
    if (!isBolt && chars[i] !== " ") letter++;
    g.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) {
        if (row[gx] !== "#") continue;
        // Banded shading: bright top, base middle, warmer bottom.
        const color = gy === 0 ? mix(base, "#FFFFFF", 0.5) : gy >= 4 ? mix(base, "#C94400", 0.3) : base;
        grid[gy]![x + gx] = { kind: "face", color };
      }
    });
    x += g[0]!.length + 1;
  });
  // 1-pixel drop shadow down-right.
  for (let y = h - 2; y >= 0; y--) {
    for (let xx = w - 2; xx >= 0; xx--) {
      const c = grid[y]![xx];
      if (c?.kind === "face" && !grid[y + 1]![xx + 1]) grid[y + 1]![xx + 1] = { kind: "drop", color: mix(c.color, "#2A1000", 0.72) };
    }
  }
  const colored = chalk.level > 0;
  const lines: string[] = [];
  for (let y = 0; y < h; y += 2) {
    let line = "";
    for (let xx = 0; xx < w; xx++) {
      const t = grid[y]![xx] ?? null;
      const b = grid[y + 1]?.[xx] ?? null;
      if (!colored) {
        const tf = t?.kind === "face";
        const bf = b?.kind === "face";
        line += tf && bf ? "█" : tf ? "▀" : bf ? "▄" : " ";
      } else if (t && b) line += t.color === b.color ? chalk.hex(t.color)("█") : chalk.hex(t.color).bgHex(b.color)("▀");
      else if (t) line += chalk.hex(t.color)("▀");
      else if (b) line += chalk.hex(b.color)("▄");
      else line += " ";
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}
