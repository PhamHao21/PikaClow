import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import { dirname } from "node:path";
import { aiLang, createProvider, prompts, readyProvider } from "../core/ai/index.js";
import type { ChatMessage } from "../core/ai/provider.js";
import { historyPath, loadConfig, saveConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { tildify } from "../core/format.js";
import { currentBranch, findRepoRoot } from "../core/git.js";
import { detectShell } from "../core/shell.js";
import { getLang, setLang, t, type MessageKey } from "../i18n/index.js";
import { ansi } from "../ui/ansi.js";
import { cmd } from "../ui/components.js";
import { reportError } from "../ui/errors.js";
import { holdKeyboard, isCtrlC, isEnter, isEscape, pushKeys, type Key } from "../ui/keys.js";
import { LineEditor } from "../ui/line-editor.js";
import { LiveRegion } from "../ui/live.js";
import { bigLogo, centerLines, logoWidth, shinePositions, smallLogo } from "../ui/logo.js";
import { blank, print } from "../ui/print.js";
import { columns, hideCursor, isInteractive, isTTY, showCursor, write } from "../ui/terminal.js";
import chalk from "chalk";
import { boxChars, c, gradientText, glyphs, mix, P, sym, themeName } from "../ui/theme.js";
import { fit, padEnd, truncate, width } from "../ui/text.js";
import { VERSION } from "../version.js";
import { askCommand } from "./ask.js";
import { cleanCommand } from "./clean.js";
import { commitCommand } from "./commit.js";
import { dashCommand } from "./dash.js";
import { doctorCommand } from "./doctor.js";
import { explainCommand } from "./explain.js";
import { modelsCommand } from "./models.js";
import { portsCommand } from "./ports.js";
import { runCommandLine, shCommand } from "./sh.js";
import { setupCommand } from "./setup.js";
import { getProvider, streamAnswer } from "./ai-common.js";

// ── Banner ─────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function animationsEnabled(): boolean {
  return isTTY() && !process.env.CI && process.env.PIKACLOW_NO_ANIM !== "1" && process.env.TERM !== "dumb";
}

export async function printBanner(): Promise<void> {
  const W = columns();
  blank();
  const logo = W >= logoWidth() + 4 ? bigLogo() : null;
  if (logo) {
    const lines = centerLines(logo, W);
    print(...lines);
    if (animationsEnabled()) {
      hideCursor();
      for (const pos of shinePositions()) {
        await sleep(26);
        write(ansi.up(lines.length) + "\r" + centerLines(bigLogo(pos)!, W).map((l) => l + ansi.clearEol).join("\n") + "\n");
      }
      write(ansi.up(lines.length) + "\r" + lines.map((l) => l + ansi.clearEol).join("\n") + "\n");
      showCursor();
    }
  } else {
    print(" " + smallLogo());
  }
  const deco = glyphs === "ascii" ? "" : c.border("▄▀▄▀ ");
  const tagline = deco + c.muted(t("home.tagline")) + (glyphs === "ascii" ? "" : c.border(" ▀▄▀▄")) + "  " + c.keycap("v" + VERSION);
  print(logo ? centerLines([tagline], W)[0]! : " " + tagline);
  blank();
}

function printTips(): void {
  print(" " + c.brand(sym("bullet")) + " " + c.bold(t("home.tipsTitle")));
  const tips: [MessageKey, Record<string, string>][] = [
    ["home.tip1", {}],
    ["home.tip2", { cmds: ["/dash", "/ports", "/clean", "/commit", "/doctor"].map((x) => c.brand(x)).join(" ") }],
    ["home.tip3", { example: cmd("!git status") }],
    ["home.tip4", { setup: cmd("/setup"), keys: c.keycap("Ctrl+C") }],
  ];
  tips.forEach(([key, vars], i) => print(" " + c.keycap(String(i + 1)) + " " + t(key, vars)));
  blank();
}

// ── Commands available as /slash ───────────────────────────────────────────────
interface Parsed {
  args: string[];
  flags: Set<string>;
  rest: string;
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

function parse(rest: string): Parsed {
  const tokens = tokenize(rest);
  return { args: tokens.filter((x) => !x.startsWith("-")), flags: new Set(tokens.filter((x) => x.startsWith("-"))), rest };
}

interface SlashCommand {
  name: string;
  aliases?: string[];
  args?: string;
  desc: MessageKey;
  run: (p: Parsed, ctx: Ctx, repl: Repl) => Promise<void>;
}

const has = (p: Parsed, ...names: string[]) => names.some((n) => p.flags.has(n));

const COMMANDS: SlashCommand[] = [
  { name: "help", aliases: ["?"], desc: "home.cmd.help", run: async (_p, _ctx, repl) => repl.help() },
  { name: "dash", desc: "cli.dash", run: (_p, ctx) => dashCommand({}, ctx) },
  { name: "top", desc: "cli.top", run: (_p, ctx) => dashCommand({ view: "processes" }, ctx) },
  { name: "ports", args: "[port] [--kill] [--all]", desc: "cli.ports", run: (p, ctx) => portsCommand(p.args[0], { all: has(p, "--all", "-a"), kill: has(p, "--kill", "-k"), yes: has(p, "--yes", "-y"), udp: has(p, "--udp", "-u"), pick: has(p, "--pick", "-i") }, ctx) },
  { name: "kill", args: "<port>", desc: "home.cmd.kill", run: (p, ctx) => (p.args[0] ? portsCommand(p.args[0], { kill: true }, ctx) : portsCommand(undefined, { pick: true }, ctx)) },
  { name: "clean", args: "[path] [--caches] [--dry-run]", desc: "cli.clean", run: (p, ctx) => cleanCommand(p.args[0], { caches: has(p, "--caches", "-c"), dryRun: has(p, "--dry-run", "-n") }, ctx) },
  { name: "doctor", desc: "cli.doctor", run: (_p, ctx) => doctorCommand({}, ctx) },
  { name: "models", args: "[--all]", desc: "cli.models", run: (p, ctx) => modelsCommand({ all: has(p, "--all", "-a") }, ctx) },
  { name: "model", args: "<name>", desc: "home.cmd.model", run: async (p, ctx, repl) => repl.switchModel(p.args[0], ctx) },
  { name: "setup", desc: "cli.setup", run: async (_p, ctx, repl) => (await setupCommand(ctx), repl.refreshStatus()) },
  { name: "commit", args: "[--no-ai]", desc: "cli.commit", run: (p, ctx) => commitCommand({ ai: !has(p, "--no-ai"), all: has(p, "--all", "-a") }, ctx) },
  { name: "sh", args: "<task>", desc: "cli.sh", run: (p, ctx) => shCommand(p.rest ? [p.rest] : [], {}, ctx) },
  { name: "explain", args: "<command>", desc: "home.cmd.explain", run: (p, ctx) => (p.rest ? explainCommand([], {}, ctx, [p.rest]) : explainCommand([], {}, ctx)) },
  { name: "ask", args: "<question>", desc: "cli.ask", run: (p, ctx) => askCommand([p.rest], ctx) },
  { name: "clear", aliases: ["new"], desc: "home.cmd.clear", run: async (_p, _ctx, repl) => repl.clear() },
  { name: "lang", args: "vi|en", desc: "home.cmd.lang", run: async (p, _ctx, repl) => repl.setLanguage(p.args[0]) },
  { name: "exit", aliases: ["quit", "q"], desc: "home.cmd.exit", run: async (_p, _ctx, repl) => repl.quit() },
];

function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((x) => x.name === n || x.aliases?.includes(n));
}

// Commands that run when typed without "/" and followed only by argument-like words
// (so "ports 3000" runs, while "clean up this function" still goes to the AI).
const BARE_COMMANDS = new Set(["dash", "top", "ports", "kill", "clean", "doctor", "models", "model", "setup", "commit", "lang", "help"]);
const ARG_LIKE = /^(-{1,2}[\w-]+|[\d,]+|[~./\\].*|[A-Za-z]:[\\/].*|[\w.-]+:[\w.-]+|vi|en)$/i;

/**
 * Turns what people naturally type into a /command, or null for a chat message:
 * "pikaclow dash" → "/dash", "pika ports 3000" → "/ports 3000", "ports 3000" → "/ports 3000", "dash" → "/dash".
 */
export function asCommand(input: string): string | null {
  const text = input.trim();
  if (text.startsWith("/")) return text;
  if (/^pika(clow)?$/i.test(text)) return "/help";
  const prefixed = /^pika(?:clow)?(?:\.cmd|\.exe)?\s+(.+)$/i.exec(text);
  if (prefixed) return "/" + prefixed[1]!.replace(/^\/+/, "");
  const [first = "", ...rest] = text.split(/\s+/);
  const command = findCommand(first);
  if (!command) return null;
  if (rest.length === 0) return "/" + text;
  if (BARE_COMMANDS.has(command.name) && rest.every((w) => ARG_LIKE.test(w))) return "/" + text;
  return null;
}

// ── The REPL ───────────────────────────────────────────────────────────────────
const MAX_HISTORY = 300;
const MAX_INPUT_ROWS = 8;

export class Repl {
  private editor = new LineEditor("", true);
  private region = new LiveRegion(() => this.draw());
  private history: string[] = [];
  private histIndex = -1;
  private draft = "";
  private sugIndex = 0;
  private exitArmedAt = 0;
  private notice = "";
  private ai: { ok: boolean | null; label: string } = { ok: null, label: "" };
  private chat: ChatMessage[] = [];
  private running = true;
  private submit: ((v: string | null) => void) | null = null;

  async start(): Promise<void> {
    await this.loadHistory();
    await printBanner();
    printTips();
    void this.refreshStatus();
    const release = holdKeyboard();
    try {
      while (this.running) {
        const line = await this.readLine();
        if (line === null) break;
        await this.dispatch(line);
      }
    } finally {
      release();
    }
    print(" " + c.brand(sym("bolt")) + " " + gradientText(t("home.bye")));
    blank();
  }

  quit(): void {
    this.running = false;
  }

  // ── Status ───────────────────────────────────────────────────────────────────
  async refreshStatus(): Promise<void> {
    this.ai = { ok: null, label: t("home.aiChecking") };
    this.draw();
    const p = createProvider();
    const st = await p.status();
    if (!st.ok) this.ai = { ok: false, label: t("home.aiOffline") };
    else {
      let model = p.model;
      if (!model && p.kind === "ollama") {
        try {
          const rp = await readyProvider();
          model = rp.model;
        } catch {
          model = undefined;
        }
      }
      this.ai = model ? { ok: true, label: `${model} · ${p.label}` } : { ok: false, label: t("home.aiNoModel") };
    }
    this.draw();
  }

  // ── Input ────────────────────────────────────────────────────────────────────
  private suggestions(): SlashCommand[] {
    const v = this.editor.value;
    if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) return [];
    const q = v.slice(1).toLowerCase();
    return COMMANDS.filter((x) => x.name.startsWith(q) || x.aliases?.some((a) => a.startsWith(q)));
  }

  private draw(): void {
    if (!this.submit) return;
    const W = columns();
    const boxW = Math.max(30, W - 2);
    const pixel = glyphs !== "ascii";
    const b = boxChars();
    const frame = (x: string) => chalk.hex(P.frame)(x);
    const inner = boxW - 4;
    const promptW = inner - 2;
    const lay = this.editor.layout(promptW);
    const empty = this.editor.value.length === 0;
    let first = 0;
    if (lay.rows.length > MAX_INPUT_ROWS) first = Math.max(0, Math.min(lay.row - MAX_INPUT_ROWS + 1, lay.rows.length - MAX_INPUT_ROWS));
    const rows = empty ? [c.faint(truncate(t("home.placeholder"), promptW))] : lay.rows.slice(first, first + MAX_INPUT_ROWS);
    const lines: string[] = [];
    // Pixel frame: one-pixel-thick sides, notched corners.
    lines.push(" " + (pixel ? " " + frame("▄".repeat(boxW - 2)) + " " : c.border(b.tl + b.h.repeat(boxW - 2) + b.tr)));
    rows.forEach((r, i) => {
      const lead = i === 0 && first === 0 ? c.brand(sym("pointer")) + " " : "  ";
      const side = pixel ? frame("█") : c.border(b.v);
      lines.push(" " + side + " " + lead + padEnd(r, promptW) + " " + side);
    });
    lines.push(" " + (pixel ? " " + frame("▀".repeat(boxW - 2)) + " " : c.border(b.bl + b.h.repeat(boxW - 2) + b.br)));

    const sugs = this.suggestions();
    if (sugs.length) {
      if (this.sugIndex >= sugs.length) this.sugIndex = 0;
      for (const [i, s] of sugs.slice(0, 9).entries()) {
        const on = i === this.sugIndex;
        const name = fit("/" + s.name + (s.args ? " " + s.args : ""), 34);
        const line = " " + (on ? c.brand(sym("pointer")) : " ") + " " + (on ? c.brandBold(name) : c.soft(name)) + " " + c.muted(t(s.desc));
        const row = truncate(line, W - 3);
        lines.push("  " + (on && chalk.level > 0 ? chalk.bgHex(P.selectBg)(padEnd(row, W - 3)) : row));
      }
    } else {
      lines.push(this.statusLine(W));
    }
    const cursor = { row: 1 + (empty ? 0 : lay.row - first), col: 5 + (empty ? 0 : lay.col) };
    showCursor();
    this.region.render(lines, cursor);
  }

  private statusLine(W: number): string {
    if (this.notice) return "  " + c.tile(sym("warn"), P.warn) + " " + c.warn(this.notice);
    const root = findRepoRoot();
    const branch = root ? currentBranch(root) : null;
    // Pixel status bar: solid segments, like a game HUD.
    const left = "  " + c.seg(tildify(process.cwd(), os.homedir()), P.segA, P.muted) + (branch ? c.seg(sym("branch") + " " + branch, P.segB, P.brand) : "");
    let ai: string;
    if (this.ai.ok === null) ai = c.seg(this.ai.label, P.segA, P.muted);
    else if (this.ai.ok) ai = c.seg(sym("dot") + " " + this.ai.label, mix(P.ok, themeName === "light" ? "#FFFFFF" : "#000000", 0.72), P.ok);
    else ai = c.seg(sym("circle") + " " + this.ai.label + " · /setup", mix(P.warn, themeName === "light" ? "#FFFFFF" : "#000000", 0.72), P.warn);
    const right = ai + c.seg(getLang().toUpperCase(), P.panel, P.brand) + " ";
    const gap = W - 1 - width(left) - width(right);
    return gap >= 2 ? left + " ".repeat(gap) + right : truncate(left, W - 1);
  }

  private readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      const done = (v: string | null) => {
        release();
        this.submit = null;
        this.region.clear();
        resolve(v);
      };
      this.submit = done;
      const release = pushKeys((k) => this.onKey(k));
      this.draw();
    });
  }

  private onKey(k: Key): void {
    const sugs = this.suggestions();
    if (isCtrlC(k)) {
      if (this.editor.value) {
        this.editor.set("");
        this.notice = "";
      } else if (Date.now() - this.exitArmedAt < 2500) {
        return this.submit?.(null);
      } else {
        this.exitArmedAt = Date.now();
        this.notice = t("home.ctrlcAgain");
        setTimeout(() => {
          if (this.notice === t("home.ctrlcAgain")) {
            this.notice = "";
            this.draw();
          }
        }, 2500).unref();
      }
      return this.draw();
    }
    this.notice = "";
    if (k.ctrl && k.name === "d" && !this.editor.value) return this.submit?.(null);
    if (k.ctrl && k.name === "l") {
      write(ansi.home + ansi.clearScreen);
      this.region = new LiveRegion(() => this.draw());
      return this.draw();
    }
    if (isEscape(k)) {
      this.editor.set("");
      return this.draw();
    }
    if (sugs.length && (k.name === "tab" || k.name === "down" || k.name === "up")) {
      if (k.name === "tab") {
        const s = sugs[this.sugIndex] ?? sugs[0]!;
        this.editor.set("/" + s.name + (s.args ? " " : ""));
        this.sugIndex = 0;
      } else {
        this.sugIndex = (this.sugIndex + (k.name === "down" ? 1 : sugs.length - 1)) % Math.min(9, sugs.length);
      }
      return this.draw();
    }
    // Ctrl+J (reported as "enter") inserts a newline; a trailing backslash does too.
    if (k.name === "enter" && !k.paste) {
      this.editor.insert("\n");
      return this.draw();
    }
    if (isEnter(k)) {
      let v = this.editor.value;
      if (v.endsWith("\\")) {
        this.editor.set(v.slice(0, -1) + "\n");
        return this.draw();
      }
      if (sugs.length && !findCommand(v.slice(1))) {
        const s = sugs[this.sugIndex] ?? sugs[0]!;
        v = "/" + s.name;
      }
      if (!v.trim()) return;
      this.editor.set("");
      this.sugIndex = 0;
      this.histIndex = -1;
      this.pushHistory(v);
      return this.submit?.(v);
    }
    if (k.name === "up" || k.name === "down") {
      if (!this.history.length) return;
      if (this.histIndex === -1) this.draft = this.editor.value;
      if (k.name === "up") this.histIndex = Math.min(this.history.length - 1, this.histIndex + 1);
      else this.histIndex = Math.max(-1, this.histIndex - 1);
      this.editor.set(this.histIndex === -1 ? this.draft : this.history[this.history.length - 1 - this.histIndex]!);
      return this.draw();
    }
    if (this.editor.handle(k)) {
      this.sugIndex = 0;
      this.draw();
    }
  }

  // ── History ──────────────────────────────────────────────────────────────────
  private async loadHistory(): Promise<void> {
    try {
      const raw = await readFile(historyPath(), "utf8");
      this.history = raw
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as string;
          } catch {
            return l;
          }
        })
        .slice(-MAX_HISTORY);
    } catch {
      this.history = [];
    }
  }

  private pushHistory(v: string): void {
    if (this.history[this.history.length - 1] === v) return;
    this.history.push(v);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    void mkdir(dirname(historyPath()), { recursive: true })
      .then(() => appendFile(historyPath(), JSON.stringify(v) + "\n"))
      .catch(() => {});
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────────
  private echo(v: string): void {
    const lines = v.split("\n");
    print(...lines.map((l, i) => " " + (i === 0 ? c.brand(sym("pointer")) : " ") + " " + c.bold(l)));
  }

  private async dispatch(v: string): Promise<void> {
    this.echo(v);
    const ac = new AbortController();
    const ctx: Ctx = { signal: ac.signal, inRepl: true };
    // While something runs, Ctrl+C cancels it instead of quitting.
    const release = pushKeys((k) => {
      if (isCtrlC(k)) ac.abort();
    });
    try {
      const trimmed = v.trim();
      if (trimmed.startsWith("!")) {
        const line = trimmed.slice(1).trim();
        if (line) {
          const code = await runCommandLine(line, detectShell());
          if (code !== 0) print(c.faint(`  ${sym("pointerSmall")} ${t("home.exitCode", { code: String(code ?? "?") })}  ·  ${t("home.explainHint", { cmd: cmd("/explain " + line) })}`));
        }
      } else {
        const slash = asCommand(trimmed);
        if (slash) {
          const [name = "", ...restParts] = slash.slice(1).split(/\s+/);
          const command = findCommand(name);
          if (!command) print(c.warn(`  ${sym("warn")} ${t("home.unknown", { name })}`) + c.faint("  /help"));
          else await command.run(parse(restParts.join(" ")), ctx, this);
        } else {
          await this.ask(trimmed, ctx);
        }
      }
    } catch (e) {
      reportError(e);
    } finally {
      release();
    }
    blank();
  }

  private async ask(question: string, ctx: Ctx): Promise<void> {
    let provider;
    try {
      provider = await getProvider(true);
    } catch (e) {
      // Without AI, a line starting with a command name was most likely meant as that command.
      const first = findCommand(question.split(/\s+/)[0] ?? "");
      if (first) {
        print(c.warn(`  ${sym("warn")} `) + t("home.didYouMean", { cmd: cmd("/" + first.name + (first.args ? " " + first.args : "")) }));
        return;
      }
      reportError(e);
      print(c.faint("  " + t("home.aiHelp", { setup: cmd("/setup"), models: cmd("/models") })));
      return;
    }
    if (!this.chat.length) this.chat.push({ role: "system", content: prompts.chat(aiLang(), detectShell()) });
    this.chat.push({ role: "user", content: question });
    blank();
    try {
      const answer = await streamAnswer(provider, this.chat, ctx.signal);
      this.chat.push({ role: "assistant", content: answer });
      // Keep the conversation small enough for local models.
      if (this.chat.length > 21) this.chat.splice(1, this.chat.length - 21);
    } catch (e) {
      this.chat.pop();
      throw e;
    }
  }

  help(): void {
    blank();
    print(" " + c.tile(t("home.helpTitle").toUpperCase()));
    for (const x of COMMANDS) {
      print(truncate("   " + c.brand(fit("/" + x.name + (x.args ? " " + x.args : ""), 36)) + "  " + c.muted(t(x.desc)), columns() - 1));
    }
    blank();
    print(" " + c.tile(t("home.keysTitle").toUpperCase()));
    const keys: [string, MessageKey][] = [
      ["Tab", "home.key.tab"],
      ["↑ ↓", "home.key.history"],
      ["\\ + Enter", "home.key.newline"],
      ["Esc", "home.key.esc"],
      ["Ctrl+L", "home.key.clear"],
      ["Ctrl+C", "home.key.ctrlc"],
    ];
    for (const [k, d] of keys) print("   " + padEnd(c.keycap(k), 14) + c.muted(t(d)));
    print("   " + padEnd(c.keycap("!cmd"), 14) + c.muted(t("home.key.shell")));
  }

  clear(): void {
    this.chat = [];
    write(ansi.home + ansi.clearScreen + ansi.clearScrollback);
    this.region = new LiveRegion(() => this.draw());
    print(" " + smallLogo() + c.faint("  " + t("home.cleared")));
  }

  setLanguage(lang: string | undefined): void {
    if (lang !== "vi" && lang !== "en") {
      print(c.muted("  " + t("home.langUsage")));
      return;
    }
    setLang(lang);
    saveConfig({ lang });
    this.chat = [];
    print("  " + c.ok(sym("ok")) + " " + t("home.langSet"));
  }

  async switchModel(name: string | undefined, ctx: Ctx): Promise<void> {
    if (!name) {
      await modelsCommand({}, ctx);
      await this.refreshStatus();
      return;
    }
    const prev = loadConfig().ai;
    saveConfig({ ai: { ...(prev ?? { provider: "ollama" }), model: name } });
    this.chat = [];
    print("  " + c.ok(sym("ok")) + " " + t("models.nowDefault", { model: c.bold(name) }));
    await this.refreshStatus();
  }
}

export async function homeCommand(): Promise<void> {
  if (!isInteractive()) {
    await printBanner();
    return;
  }
  if (glyphs === "ascii") process.env.PIKACLOW_NO_ANIM = "1";
  await new Repl().start();
}
