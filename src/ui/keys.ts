import { emitKeypressEvents } from "node:readline";
import { setRawMode } from "./terminal.js";

export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
  /** Printable text for this key, if any (letters, digits, pasted text, "ế", "日"…). */
  text: string | undefined;
  /** True while inside a bracketed paste. */
  paste: boolean;
}

export type KeyHandler = (key: Key) => void;

export class NonInteractiveError extends Error {
  constructor(message = "This command needs an interactive terminal.") {
    super(message);
    this.name = "NonInteractiveError";
  }
}

// Handlers form a stack: only the top one receives keys. Nested UIs (a confirm inside a
// dashboard, a prompt inside the REPL) push and pop without stealing each other's input.
const stack: KeyHandler[] = [];
let installed = false;
let pasting = false;
let holds = 0;

function keyboardOn(): void {
  setRawMode(true);
  process.stdin.resume();
}

// Order matters on Windows: stop reading while still in raw mode, then leave raw mode.
// The other way round libuv starts a blocking line read that keeps the process alive
// until the user presses Enter.
function keyboardOff(): void {
  process.stdin.pause();
  setRawMode(false);
}

function isPrintable(ch: string | undefined): ch is string {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
}

function onKeypress(ch: string | undefined, k: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } | undefined): void {
  const name = k?.name ?? "";
  if (name === "paste-start") {
    pasting = true;
    return;
  }
  if (name === "paste-end") {
    pasting = false;
    return;
  }
  const ctrl = Boolean(k?.ctrl);
  const meta = Boolean(k?.meta);
  let text: string | undefined;
  if (pasting && (name === "return" || name === "enter")) text = "\n";
  else if (pasting && name === "tab") text = "  ";
  else if (!ctrl && !meta && isPrintable(ch)) text = ch;
  const key: Key = {
    name: name || (text ?? ""),
    ctrl,
    meta,
    shift: Boolean(k?.shift),
    sequence: k?.sequence ?? ch ?? "",
    text,
    paste: pasting,
  };
  stack[stack.length - 1]?.(key);
}

/** Starts delivering keys to `handler` until the returned function is called. */
export function pushKeys(handler: KeyHandler): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new NonInteractiveError();
  if (!installed) {
    emitKeypressEvents(stdin);
    stdin.on("keypress", onKeypress);
    installed = true;
  }
  stack.push(handler);
  keyboardOn();
  let popped = false;
  return () => {
    if (popped) return;
    popped = true;
    const i = stack.lastIndexOf(handler);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0 && holds === 0) keyboardOff();
  };
}

/**
 * Keeps raw mode on even while no handler is listening (the REPL holds it for its
 * whole session so modes are not flipped around every command).
 */
export function holdKeyboard(): () => void {
  if (!process.stdin.isTTY) return () => {};
  holds++;
  keyboardOn();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (stack.length === 0 && holds === 0) keyboardOff();
  };
}

/** Temporarily releases the keyboard (e.g. while a child process owns the terminal). */
export async function withKeyboardReleased<T>(fn: () => Promise<T>): Promise<T> {
  const saved = stack.splice(0, stack.length);
  if (process.stdin.isTTY) keyboardOff();
  try {
    return await fn();
  } finally {
    stack.push(...saved);
    if ((stack.length > 0 || holds > 0) && process.stdin.isTTY) keyboardOn();
  }
}

export const isCtrlC = (k: Key) => k.ctrl && k.name === "c";
export const isEnter = (k: Key) => !k.paste && (k.name === "return" || k.name === "enter");
export const isEscape = (k: Key) => k.name === "escape";
