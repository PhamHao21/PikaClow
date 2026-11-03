import { ansi } from "./ansi.js";

// Tracks every terminal mode we touch so it can always be restored, even on crash or Ctrl+C.
const state = { cursorHidden: false, altScreen: false, raw: false, paste: false };

export const stdout = process.stdout;

export function write(s: string): void {
  if (s) stdout.write(s);
}

export function columns(): number {
  return Math.max(20, stdout.columns || Number(process.env.COLUMNS) || 80);
}

export function rows(): number {
  return Math.max(8, stdout.rows || Number(process.env.LINES) || 24);
}

export function isTTY(): boolean {
  return Boolean(stdout.isTTY);
}

/** True when we can read keys and draw interactive UI. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && stdout.isTTY) && process.env.PIKACLOW_NO_TTY !== "1";
}

export function hideCursor(): void {
  if (!isTTY() || state.cursorHidden) return;
  state.cursorHidden = true;
  write(ansi.hideCursor);
}

export function showCursor(): void {
  if (!state.cursorHidden) return;
  state.cursorHidden = false;
  write(ansi.showCursor);
}

export function enterAltScreen(): void {
  if (!isTTY() || state.altScreen) return;
  state.altScreen = true;
  write(ansi.altScreenOn + ansi.home + ansi.clearScreen);
}

export function leaveAltScreen(): void {
  if (!state.altScreen) return;
  state.altScreen = false;
  write(ansi.altScreenOff);
}

export function setRawMode(on: boolean): void {
  const stdin = process.stdin;
  if (!stdin.isTTY || state.raw === on) return;
  state.raw = on;
  stdin.setRawMode(on);
}

export function setBracketedPaste(on: boolean): void {
  if (!isTTY() || state.paste === on) return;
  state.paste = on;
  write(on ? ansi.pasteOn : ansi.pasteOff);
}

/** Puts the terminal back into a sane state. Safe to call many times. */
export function restoreTerminal(): void {
  try {
    setBracketedPaste(false);
    leaveAltScreen();
    showCursor();
    if (state.raw) process.stdin.pause();
    setRawMode(false);
  } catch {
    // The terminal may already be gone (e.g. window closed); nothing left to restore.
  }
}

process.on("exit", restoreTerminal);

type ResizeListener = () => void;
const resizeListeners = new Set<ResizeListener>();
let resizeHooked = false;

export function onResize(listener: ResizeListener): () => void {
  if (!resizeHooked) {
    resizeHooked = true;
    stdout.on("resize", () => {
      for (const l of [...resizeListeners]) l();
    });
  }
  resizeListeners.add(listener);
  return () => resizeListeners.delete(listener);
}
