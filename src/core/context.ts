import { restoreTerminal } from "../ui/terminal.js";

/** Passed to every command: cancellation plus whether we run inside the interactive shell. */
export interface Ctx {
  signal: AbortSignal;
  inRepl: boolean;
}

// Ctrl+C outside raw mode arrives as SIGINT. Handlers form a stack so the innermost
// operation (a scan, a child process) decides what an interrupt means.
const handlers: (() => void)[] = [];

process.on("SIGINT", () => {
  const h = handlers[handlers.length - 1];
  if (h) h();
  else {
    restoreTerminal();
    process.exit(130);
  }
});

export function onInterrupt(fn: () => void): () => void {
  handlers.push(fn);
  return () => {
    const i = handlers.lastIndexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** Context for a one-shot CLI command: first Ctrl+C cancels, second one quits. */
export function cliContext(): Ctx & { dispose: () => void } {
  const ac = new AbortController();
  let presses = 0;
  const off = onInterrupt(() => {
    presses++;
    if (presses === 1) ac.abort();
    else {
      restoreTerminal();
      process.exit(130);
    }
  });
  return { signal: ac.signal, inRepl: false, dispose: off };
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || (e as { code?: string }).code === "aborted");
}
