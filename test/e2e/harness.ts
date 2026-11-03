// Runs the CLI inside a real pseudo-terminal (ConPTY on Windows) and reads the rendered screen
// through a headless xterm. Used by e2e tests and by scripts/snap.ts for visual snapshots.
import pty from "@lydell/node-pty";
import xterm from "@xterm/headless";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "src", "cli.ts");
// Absolute loader URL so the CLI can run from any working directory (e.g. a temp git repo).
const TSX = import.meta.resolve("tsx");
const alive = new Set<Screen>();

/** Kills every pseudo-terminal still open (call from after()). */
export async function disposeAll(): Promise<void> {
  const screens = [...alive];
  alive.clear();
  for (const s of screens) s.kill();
  // Wait until each pseudo-terminal is really gone: node-pty drains output on a worker
  // thread, and exiting while it is still reading hangs the test process on Windows.
  await Promise.all(screens.map((s) => Promise.race([s.closed(), sleep(4000)])));
  await sleep(300);
}

const KEYS: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  esc: "\x1b",
  space: " ",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+l": "\x0c",
  "ctrl+u": "\x15",
};

export interface SpawnOptions {
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  cwd?: string;
  /** Run an arbitrary script instead of the CLI. */
  script?: string;
}

export class Screen {
  private term: InstanceType<typeof xterm.Terminal>;
  private proc: ReturnType<typeof pty.spawn>;
  private exited: Promise<number>;
  exitCode: number | null = null;
  raw = "";

  constructor(args: string[], opts: SpawnOptions = {}) {
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;
    this.term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      FORCE_COLOR: "3",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "vscode",
      PIKACLOW_NO_ANIM: "1",
      PIKACLOW_HOME: join(ROOT, ".snapshots", "home"),
      ...opts.env,
    };
    alive.add(this);
    this.proc = pty.spawn(process.execPath, ["--import", TSX, opts.script ?? CLI, ...args], {
      cols,
      rows,
      cwd: opts.cwd ?? ROOT,
      env,
    });
    this.proc.onData((d) => {
      this.raw += d;
      this.term.write(d);
    });
    this.exited = new Promise((resolve) => {
      this.proc.onExit(({ exitCode }) => {
        const settle = (code: number) => {
          this.exitCode = code;
          resolve(code);
        };
        if (exitCode !== undefined) return settle(exitCode);
        // node-pty on Windows can report the exit before it has read the exit code
        // (the output pipe closes first); the agent learns it a moment later.
        setTimeout(() => settle((this.proc as unknown as { _agent?: { exitCode?: number } })._agent?.exitCode ?? -1), 300);
      });
    });
  }

  write(data: string): void {
    this.proc.write(data);
  }

  press(...keys: string[]): void {
    for (const k of keys) this.proc.write(KEYS[k] ?? k);
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  /** Visible viewport as plain text lines (trailing spaces trimmed). */
  lines(): string[] {
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    return out;
  }

  text(): string {
    return this.lines().join("\n");
  }

  /** Whole buffer including scrollback. */
  allText(): string {
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
    return out.join("\n").replace(/\n+$/, "");
  }

  async waitFor(match: string | RegExp, timeoutMs = 15000, all = false): Promise<void> {
    const start = Date.now();
    for (;;) {
      await flush(this.term);
      const t = all ? this.allText() : this.text();
      if (typeof match === "string" ? t.includes(match) : match.test(t)) return;
      if (this.exitCode !== null && Date.now() - start > 300) {
        throw new Error(`Process exited (${this.exitCode}) before showing ${String(match)}.\n--- screen ---\n${t}`);
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${String(match)}.\n--- screen ---\n${t}`);
      }
      await sleep(60);
    }
  }

  async settle(ms = 400): Promise<void> {
    await sleep(ms);
    await flush(this.term);
  }

  async waitExit(timeoutMs = 15000): Promise<number> {
    const t = setTimeout(() => this.proc.kill(), timeoutMs);
    const code = await this.exited;
    clearTimeout(t);
    await flush(this.term);
    return code;
  }

  /** Resolves once the process has exited. */
  closed(): Promise<number> {
    return this.exited;
  }

  kill(): void {
    alive.delete(this);
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  /** Renders the visible screen (with colors) as a standalone HTML page. */
  html(title = "PikaClow"): string {
    return screenToHtml(this.term, title);
  }

  /** Renders the visible screen as an SVG "screenshot" (for the README). */
  svg(title = "pikaclow", trimRows = true): string {
    return screenToSvg(this.term, title, trimRows);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function flush(term: InstanceType<typeof xterm.Terminal>): Promise<void> {
  return new Promise((r) => term.write("", () => r()));
}

// ── HTML serialization ─────────────────────────────────────────────────────────
const BASE16 = [
  "#1e1e1e", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function paletteColor(n: number): string {
  if (n < 16) return BASE16[n]!;
  if (n < 232) {
    const i = n - 16;
    const v = [0, 95, 135, 175, 215, 255];
    const hex = (x: number) => x.toString(16).padStart(2, "0");
    return "#" + hex(v[Math.floor(i / 36)]!) + hex(v[Math.floor(i / 6) % 6]!) + hex(v[i % 6]!);
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

// ── SVG serialization ──────────────────────────────────────────────────────────
// Block characters become rectangles so pixel art and bars render crisply on GitHub
// regardless of the viewer's font; everything else is monospace text.
const LOWER = "▁▂▃▄▅▆▇█";
const LEFT = "▏▎▍▌▋▊▉█";

function screenToSvg(term: InstanceType<typeof xterm.Terminal>, title: string, trimRows: boolean): string {
  const b = term.buffer.active;
  const cell = b.getNullCell();
  const CW = 8.4;
  const CH = 17;
  const PAD = 18;
  const TOP = 38;
  const FG = "#d4d4d4";
  const BG = "#16161a";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let rows = term.rows;
  if (trimRows) {
    while (rows > 1 && !(b.getLine(b.viewportY + rows - 1)?.translateToString(true).trim())) rows--;
  }
  const cols = term.cols;
  const W = Math.round(cols * CW + PAD * 2);
  const H = Math.round(rows * CH + TOP + PAD);
  const rects: string[] = [];
  const texts: string[] = [];
  for (let y = 0; y < rows; y++) {
    const line = b.getLine(b.viewportY + y);
    if (!line) continue;
    let run = "";
    let runX = 0;
    let runStyle = "";
    let runCells = 0;
    const flush = () => {
      // Browsers collapse runs of spaces in SVG text while textLength still counts them,
      // which stretches glyphs. So split at 2+ spaces and place each piece at its column.
      // (Runs only mix single-width characters; wide ones get their own run.)
      const re = /\S+(?: \S+)*/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(run))) {
        const piece = m[0];
        const cells = runCells === run.length ? piece.length : runCells;
        const x0 = runX + (runCells === run.length ? m.index : 0);
        texts.push(
          `<text x="${(PAD + x0 * CW).toFixed(1)}" y="${(TOP + y * CH + 12.5).toFixed(1)}" textLength="${(cells * CW).toFixed(1)}" lengthAdjust="spacingAndGlyphs"${runStyle}>${esc(piece)}</text>`,
        );
      }
      run = "";
      runCells = 0;
    };
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell);
      const w = cell.getWidth();
      if (w === 0) continue;
      let fg = cell.isFgRGB() ? "#" + cell.getFgColor().toString(16).padStart(6, "0") : cell.isFgPalette() ? paletteColor(cell.getFgColor()) : FG;
      let bg = cell.isBgRGB() ? "#" + cell.getBgColor().toString(16).padStart(6, "0") : cell.isBgPalette() ? paletteColor(cell.getBgColor()) : "";
      if (cell.isInverse()) [fg, bg] = [bg || BG, fg];
      const ch = cell.getChars() || " ";
      const px = PAD + x * CW;
      const py = TOP + y * CH;
      if (bg) rects.push(`<rect x="${px.toFixed(1)}" y="${py}" width="${(CW * w + 0.3).toFixed(1)}" height="${CH + 0.3}" fill="${bg}"/>`);
      const lower = LOWER.indexOf(ch);
      const left = LEFT.indexOf(ch);
      if (ch === "▀" || lower >= 0 || left >= 0) {
        flush();
        if (ch === "▀") rects.push(`<rect x="${px.toFixed(1)}" y="${py}" width="${(CW + 0.3).toFixed(1)}" height="${CH / 2 + 0.3}" fill="${fg}"/>`);
        else if (lower >= 0) {
          const h = (CH * (lower + 1)) / 8;
          rects.push(`<rect x="${px.toFixed(1)}" y="${(py + CH - h).toFixed(1)}" width="${(CW + 0.3).toFixed(1)}" height="${(h + 0.3).toFixed(1)}" fill="${fg}"/>`);
        } else {
          rects.push(`<rect x="${px.toFixed(1)}" y="${py}" width="${((CW * (left + 1)) / 8 + 0.3).toFixed(1)}" height="${CH + 0.3}" fill="${fg}"/>`);
        }
        runX = x + 1;
        continue;
      }
      const styles: string[] = [];
      if (fg !== FG) styles.push(` fill="${fg}"`);
      if (cell.isBold()) styles.push(` font-weight="700"`);
      if (cell.isItalic()) styles.push(` font-style="italic"`);
      if (cell.isDim()) styles.push(` opacity="0.6"`);
      const style = styles.join("");
      if (style !== runStyle || w === 2 || run === "") {
        flush();
        runX = x;
        runStyle = style;
      }
      run += ch;
      runCells += w;
      if (w === 2) {
        flush();
        runX = x + 2;
      }
    }
    flush();
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
<rect width="${W}" height="${H}" rx="10" fill="${BG}"/>
<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
<text x="${W / 2}" y="22" text-anchor="middle" fill="#8c8c8c" font-size="12" font-family="ui-sans-serif,system-ui,sans-serif">${esc(title)}</text>
<g shape-rendering="crispEdges">${rects.join("")}</g>
<g font-family="'Cascadia Mono','JetBrains Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace" font-size="14" fill="${FG}" style="white-space:pre">${texts.join("")}</g>
</svg>
`;
}

function screenToHtml(term: InstanceType<typeof xterm.Terminal>, title: string): string {
  const b = term.buffer.active;
  const cell = b.getNullCell();
  const FG = "#d4d4d4";
  const BG = "#16161a";
  let body = "";
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.viewportY + y);
    let row = "";
    let run = "";
    let runStyle = "";
    const flushRun = () => {
      if (run) row += runStyle ? `<span style="${runStyle}">${run}</span>` : run;
      run = "";
    };
    for (let x = 0; x < term.cols; x++) {
      line?.getCell(x, cell);
      if (!line || cell.getWidth() === 0) continue;
      let fg = cell.isFgRGB() ? "#" + cell.getFgColor().toString(16).padStart(6, "0") : cell.isFgPalette() ? paletteColor(cell.getFgColor()) : "";
      let bg = cell.isBgRGB() ? "#" + cell.getBgColor().toString(16).padStart(6, "0") : cell.isBgPalette() ? paletteColor(cell.getBgColor()) : "";
      if (cell.isInverse()) [fg, bg] = [bg || BG, fg || FG];
      const styles: string[] = [];
      if (fg) styles.push(`color:${fg}`);
      if (bg) styles.push(`background:${bg}`);
      if (cell.isBold()) styles.push("font-weight:700");
      if (cell.isDim()) styles.push("opacity:.6");
      if (cell.isItalic()) styles.push("font-style:italic");
      if (cell.isUnderline()) styles.push("text-decoration:underline");
      if (cell.getWidth() === 2) styles.push("display:inline-block;width:2ch");
      const style = styles.join(";");
      const ch = cell.getChars() || " ";
      const esc = ch.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (style !== runStyle) {
        flushRun();
        runStyle = style;
      }
      run += esc;
    }
    flushRun();
    body += `<div class="r">${row || " "}</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
:root{color-scheme:dark;--cols:${term.cols}}
body{margin:0;background:#0b0b0e;display:flex;justify-content:center;padding:12px;font-family:"Cascadia Mono","Cascadia Code",Consolas,"DejaVu Sans Mono",monospace}
.t{background:${BG};color:${FG};padding:12px 14px;border-radius:10px;box-shadow:0 10px 40px #0008;font-size:min(15px,calc((100vw - 60px) / var(--cols) / 0.6));line-height:1.12}
.r{white-space:pre;height:1.12em;overflow:hidden}
</style></head><body><div class="t">${body}</div></body></html>`;
}
