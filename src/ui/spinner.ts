import { LiveRegion } from "./live.js";
import { hideCursor, isTTY, showCursor, write } from "./terminal.js";
import { c, glyphs, sym } from "./theme.js";

// Pixel spinners: a block with a missing quadrant that rotates (half blocks on old consoles).
const FRAMES = {
  full: ["▛", "▜", "▟", "▙"],
  basic: ["▀", "▐", "▄", "▌"],
  ascii: ["|", "/", "-", "\\"],
};

export function spinnerFrames(): string[] {
  return FRAMES[glyphs];
}

export interface Spinner {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  /** Removes the spinner line entirely. */
  stop(): void;
}

/**
 * Animated status line. Works only while the event loop is free, which is why all
 * heavy work in PikaClow is async. Falls back to plain lines when not a TTY.
 */
export function spinner(text: string): Spinner {
  if (!isTTY()) {
    let last = text;
    return {
      update: (t) => (last = t),
      succeed: (t) => write(c.ok(sym("ok")) + " " + (t ?? last) + "\n"),
      fail: (t) => write(c.err(sym("fail")) + " " + (t ?? last) + "\n"),
      warn: (t) => write(c.warn(sym("warn")) + " " + (t ?? last) + "\n"),
      stop: () => {},
    };
  }
  const frames = FRAMES[glyphs];
  let i = 0;
  let current = text;
  const region = new LiveRegion(() => draw());
  const draw = () => region.render([c.brand(frames[i % frames.length]!) + " " + current]);
  hideCursor();
  draw();
  const timer = setInterval(() => {
    i++;
    draw();
  }, 110);
  const end = (line: string | null) => {
    clearInterval(timer);
    if (line === null) region.dispose();
    else {
      region.render([line]);
      region.done();
    }
    showCursor();
  };
  return {
    update: (t) => {
      current = t;
      draw();
    },
    succeed: (t) => end(c.ok(sym("ok")) + " " + (t ?? current)),
    fail: (t) => end(c.err(sym("fail")) + " " + (t ?? current)),
    warn: (t) => end(c.warn(sym("warn")) + " " + (t ?? current)),
    stop: () => end(null),
  };
}
