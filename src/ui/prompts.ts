import chalk from "chalk";
import { isCtrlC, isEnter, isEscape, pushKeys, type Key } from "./keys.js";
import { LineEditor } from "./line-editor.js";
import { LiveRegion } from "./live.js";
import { columns, hideCursor, isInteractive, rows, showCursor } from "./terminal.js";
import { c, P, sym } from "./theme.js";
import { keyHints } from "./components.js";
import { padEnd, truncate, width } from "./text.js";
import { NonInteractiveError } from "./keys.js";
import { t, type MessageKey } from "../i18n/index.js";

export const CANCEL: unique symbol = Symbol("cancel");
export type Cancel = typeof CANCEL;
export const isCancel = (v: unknown): v is Cancel => v === CANCEL;

type Step<S, R> = { state?: S; done?: R; cancel?: boolean } | void;

interface Frame {
  lines: string[];
  cursor?: { row: number; col: number };
}

/**
 * Minimal prompt engine: renders `view(state)` in a live region and feeds keys to `onKey`
 * until it returns `done` or `cancel`. Leaves a one-line summary behind.
 */
function run<S, R>(opts: {
  state: S;
  view: (s: S) => Frame;
  onKey: (s: S, k: Key) => Step<S, R>;
  summary: (s: S, result: R | Cancel) => string;
  signal?: AbortSignal;
}): Promise<R | Cancel> {
  if (!isInteractive()) return Promise.reject(new NonInteractiveError());
  return new Promise((resolve) => {
    let state = opts.state;
    const region = new LiveRegion(() => draw());
    const draw = () => {
      const f = opts.view(state);
      if (f.cursor) showCursor();
      else hideCursor();
      region.render(f.lines, f.cursor);
    };
    const finish = (result: R | Cancel) => {
      release();
      opts.signal?.removeEventListener("abort", onAbort);
      hideCursor();
      region.render([opts.summary(state, result)]);
      region.done();
      showCursor();
      resolve(result);
    };
    const onAbort = () => finish(CANCEL);
    const release = pushKeys((k) => {
      const step = opts.onKey(state, k);
      if (!step) return;
      if (step.state) state = step.state;
      if (step.cancel) return finish(CANCEL);
      if ("done" in step && step.done !== undefined) return finish(step.done);
      draw();
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    draw();
  });
}

// ── Pixel chrome shared by all prompts ─────────────────────────────────────────
//   ■ Question
//   ▌ ► option (highlighted bar)
//   ▌   option
//   ▀ [↑↓] move [enter] select [esc] cancel
const header = (message: string) => c.brand(sym("diamond")) + " " + c.bold(message);
const gutter = () => c.border(sym("bar")) + " ";
const footer = (pairs: [string, MessageKey][]) => c.border(sym("barEnd")) + " " + keyHints(pairs.map(([k, label]) => [k, t(label)]));
const cancelled = (message: string) => c.faint(sym("diamondOpen") + " " + message + " · " + t("prompt.cancelled"));
const answered = (message: string, answer: string) => c.ok(sym("diamond")) + " " + c.muted(message) + c.faint(" · ") + answer;

/** A menu row; the highlighted one gets a solid bar across the line, like a game menu. */
function menuRow(content: string, on: boolean): string {
  const w = Math.max(20, columns() - 4);
  const line = (on ? c.brand(sym("pointer")) : " ") + " " + content;
  return gutter() + (on && chalk.level > 0 ? chalk.bgHex(P.selectBg)(padEnd(truncate(line, w), w)) : line);
}

// ── select ─────────────────────────────────────────────────────────────────────
export interface Option<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function select<T>(opts: { message: string; options: Option<T>[]; initial?: number; signal?: AbortSignal }): Promise<T | Cancel> {
  const count = opts.options.length;
  const firstEnabled = Math.max(0, opts.options.findIndex((o) => !o.disabled));
  const move = (from: number, dir: number) => {
    for (let i = 1; i <= count; i++) {
      const next = (from + dir * i + count * 2) % count;
      if (!opts.options[next]?.disabled) return next;
    }
    return from;
  };
  return run({
    state: { index: opts.initial ?? firstEnabled },
    signal: opts.signal,
    view: (s) => ({
      lines: [
        header(opts.message),
        ...opts.options.map((o, i) => {
          const on = i === s.index;
          const label = o.disabled ? c.faint(o.label) : on ? c.brandBold(o.label) : o.label;
          const hint = o.hint ? "  " + c.muted(o.hint) : "";
          return menuRow(label + hint, on);
        }),
        footer([
          ["↑↓", "hint.move"],
          ["enter", "hint.select"],
          ["esc", "hint.cancel"],
        ]),
      ],
    }),
    onKey: (s, k) => {
      if (isCtrlC(k) || isEscape(k) || k.name === "q") return { cancel: true };
      if (k.name === "up" || k.name === "k") return { state: { index: move(s.index, -1) } };
      if (k.name === "down" || k.name === "j" || k.name === "tab") return { state: { index: move(s.index, 1) } };
      if (isEnter(k)) {
        const o = opts.options[s.index];
        if (o && !o.disabled) return { done: { value: o.value } };
      }
      // Number keys pick directly.
      const n = Number(k.text);
      if (Number.isInteger(n) && n >= 1 && n <= count && !opts.options[n - 1]?.disabled) {
        return { done: { value: opts.options[n - 1]!.value } };
      }
      return undefined;
    },
    summary: (s, r) => (isCancel(r) ? cancelled(opts.message) : answered(opts.message, c.brand(opts.options[s.index]?.label ?? ""))),
  }).then((r) => (isCancel(r) ? r : r.value));
}

// ── multiselect ────────────────────────────────────────────────────────────────
export interface MultiOption<T> extends Option<T> {
  selected?: boolean;
}

export function multiselect<T>(opts: {
  message: string;
  options: MultiOption<T>[];
  /** Extra line under the list, e.g. "3 selected · 1.2 GB". */
  status?: (selected: T[]) => string;
  required?: boolean;
  signal?: AbortSignal;
}): Promise<T[] | Cancel> {
  const count = opts.options.length;
  const pageSize = () => Math.max(3, Math.min(count, rows() - 7));
  type S = { index: number; top: number; picked: Set<number>; warn: boolean };
  const picked = new Set<number>();
  opts.options.forEach((o, i) => o.selected && !o.disabled && picked.add(i));
  const values = (s: S) => [...s.picked].sort((a, b) => a - b).map((i) => opts.options[i]!.value);
  const scroll = (s: S, index: number): S => {
    const size = pageSize();
    let top = s.top;
    if (index < top) top = index;
    if (index >= top + size) top = index - size + 1;
    return { ...s, index, top, warn: false };
  };
  return run<S, T[]>({
    state: { index: 0, top: 0, picked, warn: false },
    signal: opts.signal,
    view: (s) => {
      const size = pageSize();
      const visible = opts.options.slice(s.top, s.top + size);
      const lines = [header(opts.message)];
      if (s.top > 0) lines.push(gutter() + c.faint(`  ${sym("up")} ${s.top}`));
      visible.forEach((o, j) => {
        const i = s.top + j;
        const on = i === s.index;
        const box = s.picked.has(i) ? c.brand(sym("checkOn")) : c.muted(sym("checkOff"));
        const label = o.disabled ? c.faint(o.label) : on ? c.brandBold(o.label) : o.label;
        const hint = o.hint ? "  " + c.muted(o.hint) : "";
        lines.push(menuRow(box + " " + label + hint, on));
      });
      const below = count - (s.top + visible.length);
      if (below > 0) lines.push(gutter() + c.faint(`  ${sym("down")} ${below}`));
      if (opts.status) lines.push(gutter() + opts.status(values(s)));
      if (s.warn) lines.push(gutter() + c.warn(t("prompt.pickOne")));
      lines.push(
        footer([
          ["↑↓", "hint.move"],
          ["space", "hint.toggle"],
          ["a", "hint.all"],
          ["enter", "hint.confirm"],
          ["esc", "hint.cancel"],
        ]),
      );
      return { lines };
    },
    onKey: (s, k) => {
      if (isCtrlC(k) || isEscape(k) || k.name === "q") return { cancel: true };
      if (k.name === "up" || k.name === "k") return { state: scroll(s, (s.index - 1 + count) % count) };
      if (k.name === "down" || k.name === "j") return { state: scroll(s, (s.index + 1) % count) };
      if (k.name === "pageup") return { state: scroll(s, Math.max(0, s.index - pageSize())) };
      if (k.name === "pagedown") return { state: scroll(s, Math.min(count - 1, s.index + pageSize())) };
      if (k.name === "home") return { state: scroll(s, 0) };
      if (k.name === "end") return { state: scroll(s, count - 1) };
      if (k.name === "space") {
        const next = new Set(s.picked);
        if (opts.options[s.index]?.disabled) return undefined;
        if (next.has(s.index)) next.delete(s.index);
        else next.add(s.index);
        return { state: { ...s, picked: next, warn: false } };
      }
      if (k.name === "a") {
        const all = opts.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
        const next = s.picked.size === all.length ? new Set<number>() : new Set(all);
        return { state: { ...s, picked: next, warn: false } };
      }
      if (k.name === "n") return { state: { ...s, picked: new Set<number>(), warn: false } };
      if (isEnter(k)) {
        if (opts.required && s.picked.size === 0) return { state: { ...s, warn: true } };
        return { done: values(s) };
      }
      return undefined;
    },
    summary: (s, r) => (isCancel(r) ? cancelled(opts.message) : answered(opts.message, c.brand(String(s.picked.size)))),
  });
}

// ── confirm ────────────────────────────────────────────────────────────────────
/** A pixel button: solid block with a drop shadow on the row below. */
function button(label: string, on: boolean, danger: boolean): { face: string; shadow: string } {
  const text = ` ${label.toUpperCase()} `;
  if (chalk.level === 0) return { face: on ? `[${text}]` : ` ${text} `, shadow: "" };
  const bg = on ? (danger ? P.err : P.brand) : P.panel;
  const fg = on ? P.ink : P.muted;
  return { face: chalk.bgHex(bg).hex(fg).bold(text), shadow: chalk.hex(P.shadow)("▀".repeat(width(text))) };
}

export function confirm(opts: { message: string; initial?: boolean; danger?: boolean; signal?: AbortSignal }): Promise<boolean | Cancel> {
  const yes = t("prompt.yes");
  const no = t("prompt.no");
  return run<{ value: boolean }, boolean>({
    state: { value: opts.initial ?? false },
    signal: opts.signal,
    view: (s) => {
      const icon = opts.danger ? c.tile(sym("warn"), P.err) : c.brand(sym("diamond"));
      const y = button(yes, s.value, Boolean(opts.danger));
      const n = button(no, !s.value, false);
      return {
        lines: [
          icon + " " + c.bold(opts.message),
          gutter() + " " + y.face + "   " + n.face,
          gutter() + "  " + y.shadow + "   " + n.shadow,
          footer([
            ["y", "hint.yes"],
            ["n", "hint.no"],
            ["←→", "hint.switch"],
            ["enter", "hint.confirm"],
          ]),
        ],
      };
    },
    onKey: (s, k) => {
      if (isCtrlC(k) || isEscape(k)) return { cancel: true };
      if (k.name === "left" || k.name === "right" || k.name === "tab" || k.name === "h" || k.name === "l") {
        return { state: { value: !s.value } };
      }
      const ch = k.text?.toLowerCase();
      if (ch === "y" || ch === "c") return { done: true };
      if (ch === "n" || ch === "k") return { done: false };
      if (isEnter(k)) return { done: s.value };
      return undefined;
    },
    summary: (_s, r) => (isCancel(r) ? cancelled(opts.message) : answered(opts.message, r ? c.ok(yes) : c.muted(no))),
  });
}

// ── text input ─────────────────────────────────────────────────────────────────
export function input(opts: {
  message: string;
  initial?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  mask?: boolean;
  signal?: AbortSignal;
}): Promise<string | Cancel> {
  const editor = new LineEditor(opts.initial ?? "");
  let error: string | undefined;
  return run<{ n: number }, string>({
    state: { n: 0 },
    signal: opts.signal,
    view: () => {
      const prefix = gutter() + c.brand(sym("pointer")) + " ";
      const avail = Math.max(10, columns() - 6);
      const shown = opts.mask ? new LineEditor("•".repeat(editor.value.length)) : editor;
      if (opts.mask) shown.cursor = editor.cursor;
      const lay = shown.layout(avail);
      const empty = editor.value.length === 0;
      const body = empty && opts.placeholder ? [c.faint(opts.placeholder)] : lay.rows;
      const lines = [header(opts.message), ...body.map((r, i) => (i === 0 ? prefix : gutter() + "  ") + r)];
      if (error) lines.push(gutter() + c.tile(sym("fail"), P.err) + " " + c.err(error));
      lines.push(
        footer([
          ["enter", "hint.submit"],
          ["esc", "hint.cancel"],
        ]),
      );
      return { lines, cursor: { row: 1 + (empty ? 0 : lay.row), col: 4 + (empty ? 0 : lay.col) } };
    },
    onKey: (s, k) => {
      if (isCtrlC(k) || isEscape(k)) return { cancel: true };
      if (isEnter(k)) {
        error = opts.validate?.(editor.value);
        if (error) return { state: { n: s.n + 1 } };
        return { done: editor.value };
      }
      if (editor.handle(k)) {
        error = undefined;
        return { state: { n: s.n + 1 } };
      }
      return undefined;
    },
    summary: (_s, r) => (isCancel(r) ? cancelled(opts.message) : answered(opts.message, c.brand(opts.mask ? "•••" : editor.value))),
  });
}
