import { ansi } from "./ansi.js";
import { columns, enterAltScreen, hideCursor, leaveAltScreen, onResize, rows, showCursor, write } from "./terminal.js";
import { truncate, width } from "./text.js";

/**
 * Full-screen canvas on the alternate screen buffer (like vim/htop): the user's
 * scrollback is untouched and restored on exit. Only rows that changed are rewritten,
 * wrapped in synchronized-output markers to avoid flicker.
 */
export class FullScreen {
  private prev: string[] = [];
  private offResize: (() => void) | null = null;

  constructor(private onResized: () => void) {}

  enter(): void {
    enterAltScreen();
    hideCursor();
    this.offResize = onResize(() => {
      this.prev = [];
      write(ansi.clearScreen);
      this.onResized();
    });
  }

  get cols(): number {
    return columns();
  }

  get rows(): number {
    return rows();
  }

  draw(lines: string[]): void {
    const h = this.rows;
    const w = this.cols;
    let out = "";
    for (let y = 0; y < h; y++) {
      const raw = lines[y] ?? "";
      const line = truncate(raw, w);
      if (this.prev[y] === line) continue;
      out += ansi.to(y + 1, 1) + line + (width(line) < w ? ansi.reset + ansi.clearEol : ansi.reset);
      this.prev[y] = line;
    }
    if (out) write(ansi.syncStart + out + ansi.syncEnd);
  }

  /** Forces a full repaint on the next draw. */
  invalidate(): void {
    this.prev = [];
  }

  exit(): void {
    this.offResize?.();
    this.offResize = null;
    leaveAltScreen();
    showCursor();
  }
}
