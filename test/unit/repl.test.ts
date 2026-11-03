import { test } from "node:test";
import assert from "node:assert/strict";
import { asCommand } from "../../src/commands/home.js";

test("REPL understands commands typed the way people type them", () => {
  assert.equal(asCommand("/ports 3000"), "/ports 3000");
  assert.equal(asCommand("pikaclow dash"), "/dash");
  assert.equal(asCommand("PikaClow ports 3000 --kill"), "/ports 3000 --kill");
  assert.equal(asCommand("pika clean ~/code --dry-run"), "/clean ~/code --dry-run");
  assert.equal(asCommand("pikaclow /doctor"), "/doctor");
  assert.equal(asCommand("pikaclow"), "/help");
  assert.equal(asCommand("dash"), "/dash");
  assert.equal(asCommand("ports 3000,5173"), "/ports 3000,5173");
  assert.equal(asCommand("kill 8080"), "/kill 8080");
  assert.equal(asCommand("clean D:\code"), "/clean D:\code");
  assert.equal(asCommand("model qwen3:4b"), "/model qwen3:4b");
  assert.equal(asCommand("lang vi"), "/lang vi");
});

test("REPL leaves normal questions for the AI", () => {
  assert.equal(asCommand("clean up this function please"), null);
  assert.equal(asCommand("explain what a closure is"), null);
  assert.equal(asCommand("how do I undo a commit?"), null);
  assert.equal(asCommand("commit message conventions?"), null);
  assert.equal(asCommand("ports là gì"), null);
});
