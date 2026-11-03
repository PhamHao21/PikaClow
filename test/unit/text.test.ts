import { test } from "node:test";
import assert from "node:assert/strict";
import { center, fit, graphemes, stripAnsi, truncate, truncateStart, width, wrap } from "../../src/ui/text.js";
import { LineEditor } from "../../src/ui/line-editor.js";
import type { Key } from "../../src/ui/keys.js";

const key = (name: string, extra: Partial<Key> = {}): Key => ({ name, ctrl: false, meta: false, shift: false, sequence: "", text: undefined, paste: false, ...extra });
const typed = (text: string): Key => key(text, { text });

test("width ignores ANSI and counts wide characters", () => {
  assert.equal(width("\x1b[31mabc\x1b[0m"), 3);
  assert.equal(width("日本"), 4);
  assert.equal(width("Tiếng Việt"), 10);
  assert.equal(width("⚡"), 2);
});

test("truncate keeps colors valid and adds an ellipsis", () => {
  const s = truncate("\x1b[31mhello world\x1b[0m", 6);
  assert.equal(stripAnsi(s), "hello…");
  assert.ok(s.includes("\x1b[0m"), "reset is appended after a cut inside a color");
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("abc", 0), "");
});

test("truncateStart keeps the end of paths", () => {
  assert.equal(truncateStart("C:\\very\\long\\path\\file.ts", 12), "…ath\\file.ts");
});

test("fit pads and aligns to an exact width", () => {
  assert.equal(fit("ab", 5), "ab   ");
  assert.equal(fit("ab", 5, "right"), "   ab");
  assert.equal(width(fit("⚡ go", 6)), 6);
  assert.equal(center("ab", 6), "  ab  ");
});

test("wrap breaks long text by words", () => {
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
});

test("graphemes treat combined characters as one unit", () => {
  assert.equal(graphemes("ế").length, 1);
  assert.equal(graphemes("e\u0302\u0301").length, 1);
});

test("LineEditor edits by grapheme and handles word keys", () => {
  const ed = new LineEditor();
  for (const ch of "xin chào") ed.handle(typed(ch));
  assert.equal(ed.value, "xin chào");
  ed.handle(key("backspace"));
  assert.equal(ed.value, "xin chà");
  ed.handle(key("w", { ctrl: true }));
  assert.equal(ed.value, "xin ");
  ed.handle(key("home"));
  ed.handle(typed(">"));
  assert.equal(ed.value, ">xin ");
  ed.handle(key("k", { ctrl: true }));
  assert.equal(ed.value, ">");
});

test("LineEditor single-line mode flattens pasted newlines; multiline keeps them", () => {
  const one = new LineEditor();
  one.insert("a\r\nb");
  assert.equal(one.value, "a b");
  const multi = new LineEditor("", true);
  multi.insert("a\r\nb");
  assert.equal(multi.value, "a\nb");
  const lay = multi.layout(20);
  assert.deepEqual(lay.rows, ["a", "b"]);
  assert.deepEqual([lay.row, lay.col], [1, 1]);
});

test("LineEditor layout wraps and places the cursor", () => {
  const ed = new LineEditor("abcdefgh");
  const lay = ed.layout(3);
  assert.deepEqual(lay.rows, ["abc", "def", "gh"]);
  assert.deepEqual([lay.row, lay.col], [2, 2]);
  ed.cursor = 3;
  const l2 = ed.layout(3);
  assert.deepEqual([l2.row, l2.col], [1, 0]);
});
