import chalk from "chalk";
import { LiveRegion } from "./live.js";
import { columns, isTTY, write } from "./terminal.js";
import { c, glyphs, P, sym } from "./theme.js";
import { truncate, width, wrap } from "./text.js";

// Renders the Markdown that AI models produce (headings, lists, code blocks, inline code,
// bold/italic, links, quotes) into pixel-styled terminal lines. Works incrementally for streaming.

interface State {
  inCode: boolean;
  lang: string;
}

const MARGIN = "  ";

function inline(text: string): string {
  // Split out `code` spans first so nothing inside them gets formatted.
  return text
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return c.chip(part.slice(1, -1));
      return part
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => chalk.bold(a ?? b))
        .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, (_m, pre, a) => pre + chalk.italic(a))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => chalk.underline(label) + c.faint(` (${url})`));
    })
    .join("");
}

function wrapWithPrefix(text: string, w: number, first: string, rest: string): string[] {
  const avail = Math.max(10, w - width(first));
  const lines = wrap(text, avail);
  return lines.map((l, i) => (i === 0 ? first : rest) + l);
}

// Pixel chrome: a thick bar left of code blocks with the language in a tab, block
// markers for headings and quotes.
function chars() {
  const ascii = glyphs === "ascii";
  return { top: ascii ? "-" : "▄", side: ascii ? "|" : "█", bottom: ascii ? "-" : "▀", bar: ascii ? "|" : "▌" };
}

const frame = (s: string) => chalk.hex(P.border)(s);

function formatLine(raw: string, state: State, w: number): string[] {
  const line = raw.replace(/\r$/, "");
  const f = chars();
  const ruleW = Math.max(10, Math.min(44, w - 6));
  const fence = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(line);
  if (fence) {
    if (!state.inCode) {
      state.inCode = true;
      state.lang = fence[2] ?? "";
      const tab = c.tile(state.lang || "code");
      return [MARGIN + frame(f.top) + tab + frame(f.top.repeat(Math.max(0, ruleW - 1 - width(tab))))];
    }
    state.inCode = false;
    state.lang = "";
    return [MARGIN + frame(f.bottom.repeat(ruleW))];
  }
  if (state.inCode) {
    return [MARGIN + frame(f.side) + " " + truncate(chalk.hex(P.brandSoft)(line.replace(/\t/g, "  ")), Math.max(10, w - 6))];
  }
  if (line.trim() === "") return [""];
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    const text = inline(heading[2] ?? "");
    const major = (heading[1]?.length ?? 1) <= 2;
    const mark = c.brand(major ? f.side : f.bar) + " ";
    return wrapWithPrefix(major ? chalk.bold.hex(P.brand)(text) : chalk.bold(text), w, MARGIN + mark, MARGIN + "  ");
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [MARGIN + c.faint((glyphs === "ascii" ? "--" : "▀▄").repeat(Math.floor(ruleW / 2)))];
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) {
    const indent = MARGIN + " ".repeat(Math.min(8, bullet[1]?.length ?? 0));
    return wrapWithPrefix(inline(bullet[2] ?? ""), w, indent + c.brand(sym("bullet")) + " ", indent + "  ");
  }
  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (numbered) {
    const indent = MARGIN + " ".repeat(Math.min(8, numbered[1]?.length ?? 0));
    const n = numbered[2] ?? "1";
    const tag = c.tile(n, P.border);
    return wrapWithPrefix(inline(numbered[3] ?? ""), w, indent + tag + " ", indent + " ".repeat(width(tag) + 1));
  }
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) return wrapWithPrefix(chalk.italic(inline(quote[1] ?? "")), w, MARGIN + frame(f.bar) + " ", MARGIN + frame(f.bar) + " ");
  if (/^\s*\|.*\|\s*$/.test(line)) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return [MARGIN + c.faint(truncate(line, w - 2))];
    return [MARGIN + truncate(inline(line), w - 2)];
  }
  return wrapWithPrefix(inline(line), w, MARGIN, MARGIN);
}

/**
 * Streams Markdown to the terminal: finished lines are printed permanently,
 * the line still being generated is shown in a live region.
 */
export class MarkdownStream {
  private buf = "";
  private state: State = { inCode: false, lang: "" };
  private region: LiveRegion | null = isTTY() ? new LiveRegion(() => this.preview()) : null;
  private blankRun = 0;
  private hasContent = false;
  printed = 0;

  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    const out: string[] = [];
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      out.push(...this.format(line));
    }
    if (out.length) {
      this.region?.clear();
      write(out.map((l) => l + "\r\n").join(""));
      this.printed += out.length;
    }
    this.preview();
  }

  end(): void {
    const rest = this.buf;
    this.buf = "";
    this.region?.clear();
    if (rest.trim()) {
      const lines = this.format(rest);
      write(lines.map((l) => l + "\r\n").join(""));
      this.printed += lines.length;
    }
    if (this.state.inCode) {
      write(this.format("```").map((l) => l + "\r\n").join(""));
    }
    this.region?.dispose();
  }

  private format(line: string): string[] {
    const lines = formatLine(line, this.state, columns());
    // Collapse runs of blank lines the model sometimes emits, and drop leading ones.
    return lines.filter((l) => {
      if (l === "") {
        this.blankRun++;
        return this.blankRun <= 1 && this.hasContent;
      }
      this.blankRun = 0;
      this.hasContent = true;
      return true;
    });
  }

  private preview(): void {
    if (!this.region) return;
    if (!this.buf) {
      this.region.clear();
      return;
    }
    const copy = { ...this.state };
    this.region.render(formatLine(this.buf, copy, columns()));
  }
}
