import { ansi } from "./ansi.js";
import { columns, onResize, write } from "./terminal.js";
import { truncate, width } from "./text.js";

/**
 * A block of lines at the bottom of the output that can be redrawn in place
 * (spinners, prompts, progress, the REPL input box). Lines are always cut to the
 * terminal width so we know exactly how many rows are on screen.
 */
export class LiveRegion {
  private widths: number[] = [];
  private cursorRow = 0;
  private cursorCol = 0;
  private drawnCols = columns();
  private active = false;
  private offResize: (() => void) | null = null;

  constructor(private onResized?: () => void) {}

  get height(): number {
    return this.widths.length;
  }

  render(lines: string[], cursor?: { row: number; col: number }): void {
    const cols = columns();
    const max = Math.max(1, cols - 1);
    const safe = lines.map((l) => truncate(l, max));
    let out = this.eraseSequence(cols);
    out += safe.map((l) => l + ansi.clearEol).join("\r\n");
    this.widths = safe.map(width);
    this.drawnCols = cols;
    const last = Math.max(0, safe.length - 1);
    if (cursor && safe.length > 0) {
      const row = Math.max(0, Math.min(last, cursor.row));
      const col = Math.min(max, cursor.col);
      out += ansi.up(last - row) + ansi.column(col + 1);
      this.cursorRow = row;
      this.cursorCol = col;
    } else {
      this.cursorRow = last;
      this.cursorCol = this.widths[last] ?? 0;
    }
    write(ansi.syncStart + out + ansi.syncEnd);
    if (!this.active) {
      this.active = true;
      this.offResize = onResize(() => this.onResized?.());
    }
  }

  /** Removes the region from the screen; the cursor ends where the region began. */
  clear(): void {
    if (this.widths.length === 0) return;
    write(this.eraseSequence(columns()));
    this.widths = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  /** Leaves the current content on screen and moves the cursor below it. */
  done(): void {
    if (this.widths.length > 0) {
      const last = this.widths.length - 1;
      write(ansi.down(last - this.cursorRow) + "\r\n");
    }
    this.widths = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.active = false;
    this.offResize?.();
    this.offResize = null;
  }

  /** Clears the region and stops listening for resizes. */
  dispose(): void {
    this.clear();
    this.active = false;
    this.offResize?.();
    this.offResize = null;
  }

  private eraseSequence(cols: number): string {
    if (this.widths.length === 0) return "\r";
    // When the terminal got narrower it re-flowed our old lines onto extra rows,
    // including the line the cursor sits on.
    const shrunk = cols < this.drawnCols;
    const rowsFor = (w: number) => (shrunk ? Math.max(1, Math.ceil(w / cols)) : 1);
    let up = 0;
    for (let i = 0; i < this.cursorRow; i++) up += rowsFor(this.widths[i] ?? 0);
    if (shrunk) up += Math.floor(this.cursorCol / cols);
    return ansi.up(up) + "\r" + ansi.clearDown;
  }
}
