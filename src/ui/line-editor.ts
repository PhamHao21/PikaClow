import type { Key } from "./keys.js";
import { graphemes, width } from "./text.js";

/**
 * A small text editor working on grapheme clusters, so Vietnamese diacritics,
 * CJK and emoji move and delete as one unit.
 */
export class LineEditor {
  private chars: string[] = [];
  cursor = 0;

  /** With multiline, pasted or typed newlines are kept; otherwise they become spaces. */
  constructor(
    initial = "",
    private multiline = false,
  ) {
    this.set(initial);
  }

  get value(): string {
    return this.chars.join("");
  }

  set(value: string): void {
    this.chars = graphemes(value.normalize("NFC"));
    this.cursor = this.chars.length;
  }

  insert(text: string): void {
    const clean = text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
    const add = graphemes(this.multiline ? clean : clean.replace(/\n/g, " "));
    this.chars.splice(this.cursor, 0, ...add);
    this.cursor += add.length;
  }

  /**
   * Applies an editing key. Returns true if the key was consumed.
   * Enter, Tab, Up/Down and Escape are left to the caller.
   */
  handle(key: Key): boolean {
    if (key.text !== undefined) {
      this.insert(key.text);
      return true;
    }
    const n = this.chars.length;
    if (key.ctrl) {
      switch (key.name) {
        case "a":
          this.cursor = 0;
          return true;
        case "e":
          this.cursor = n;
          return true;
        case "u":
          this.chars.splice(0, this.cursor);
          this.cursor = 0;
          return true;
        case "k":
          this.chars.splice(this.cursor);
          return true;
        case "w":
        case "backspace":
          this.deleteWordLeft();
          return true;
        case "left":
          this.cursor = this.wordLeft();
          return true;
        case "right":
          this.cursor = this.wordRight();
          return true;
        case "delete":
          this.chars.splice(this.cursor, this.wordRight() - this.cursor);
          return true;
        default:
          return false;
      }
    }
    if (key.meta && (key.name === "left" || key.name === "b")) {
      this.cursor = this.wordLeft();
      return true;
    }
    if (key.meta && (key.name === "right" || key.name === "f")) {
      this.cursor = this.wordRight();
      return true;
    }
    if (key.meta && key.name === "backspace") {
      this.deleteWordLeft();
      return true;
    }
    switch (key.name) {
      case "backspace":
        if (this.cursor > 0) {
          this.chars.splice(this.cursor - 1, 1);
          this.cursor--;
        }
        return true;
      case "delete":
        if (this.cursor < n) this.chars.splice(this.cursor, 1);
        return true;
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case "right":
        this.cursor = Math.min(n, this.cursor + 1);
        return true;
      case "home":
        this.cursor = 0;
        return true;
      case "end":
        this.cursor = n;
        return true;
      default:
        return false;
    }
  }

  private wordLeft(): number {
    let i = this.cursor;
    while (i > 0 && this.chars[i - 1] === " ") i--;
    while (i > 0 && this.chars[i - 1] !== " ") i--;
    return i;
  }

  private wordRight(): number {
    let i = this.cursor;
    const n = this.chars.length;
    while (i < n && this.chars[i] === " ") i++;
    while (i < n && this.chars[i] !== " ") i++;
    return i;
  }

  private deleteWordLeft(): void {
    const start = this.wordLeft();
    this.chars.splice(start, this.cursor - start);
    this.cursor = start;
  }

  /**
   * Wraps the text into rows of at most `w` cells.
   * Returns the rows and the cursor position within them.
   */
  layout(w: number): { rows: string[]; row: number; col: number } {
    const rows: string[] = [];
    let line = "";
    let lineW = 0;
    let row = 0;
    let col = 0;
    for (let i = 0; i <= this.chars.length; i++) {
      if (i === this.cursor) {
        if (lineW >= w) {
          rows.push(line);
          line = "";
          lineW = 0;
        }
        row = rows.length;
        col = lineW;
      }
      if (i === this.chars.length) break;
      const ch = this.chars[i]!;
      if (ch === "\n") {
        rows.push(line);
        line = "";
        lineW = 0;
        continue;
      }
      const cw = width(ch);
      if (lineW + cw > w) {
        rows.push(line);
        line = "";
        lineW = 0;
        if (i === this.cursor) {
          row = rows.length;
          col = 0;
        }
      }
      line += ch;
      lineW += cw;
    }
    rows.push(line);
    return { rows, row, col };
  }
}
