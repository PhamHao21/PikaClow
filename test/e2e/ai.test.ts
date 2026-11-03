// AI features end-to-end against a mock Ollama/OpenAI server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { disposeAll, Screen } from "./harness.js";
import { startMockAi, type MockAi } from "../helpers/mock-ai.js";

let mock: MockAi;
let home: string;
let repo: string;

before(async () => {
  mock = await startMockAi();
  home = mkdtempSync(join(os.tmpdir(), "pikaclow-aihome-"));
  repo = mkdtempSync(join(os.tmpdir(), "pikaclow-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  git("add", ".");
  git("commit", "-qm", "chore: init");
});

after(async () => {
  await disposeAll();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const env = () => ({ PIKACLOW_HOME: home, PIKACLOW_LANG: "en", PIKACLOW_PROVIDER: "ollama", PIKACLOW_BASE_URL: mock.url, PIKACLOW_MODEL: "qwen3:4b" });

test("ask streams a Markdown answer and hides reasoning", async () => {
  mock.reply = "## Answer\nUse **git revert** or `git reset --soft HEAD~1`.";
  const s = new Screen(["ask", "how to undo last commit"], { env: env() });
  assert.equal(await s.waitExit(20000), 0);
  const text = s.allText();
  assert.match(text, /Answer/);
  assert.match(text, /git reset --soft HEAD~1/);
  assert.doesNotMatch(text, /secret reasoning|<think>/);
  const chat = mock.requests.find((r) => r.path === "/api/chat");
  assert.equal(chat?.body.model, "qwen3:4b");
  assert.match(chat?.body.messages[0].content, /PikaClow/);
});

test("sh shows the command with a safety verdict and can be cancelled", async () => {
  mock.reply = "COMMAND: Remove-Item .\\dist -Recurse -Force\nEXPLAIN: Deletes the dist folder.";
  const s = new Screen(["sh", "delete the dist folder"], { env: env(), cols: 110 });
  await s.waitFor("Remove-Item .\\dist -Recurse -Force", 20000);
  await s.waitFor("DANGEROUS");
  await s.waitFor("deletes folders recursively");
  await s.waitFor("Run it?");
  s.press("esc");
  assert.equal(await s.waitExit(), 0);
});

test("sh runs a safe command after choosing Run", async () => {
  mock.reply = "COMMAND: echo pika-run-ok\nEXPLAIN: Prints a word.";
  const s = new Screen(["sh", "print something"], { env: env(), cols: 110 });
  await s.waitFor("No risky operations detected", 20000);
  s.press("enter");
  await s.waitFor(/^pika-run-ok/m, 20000);
  await s.waitFor("exit code 0");
  assert.equal(await s.waitExit(), 0);
});

test("commit writes an AI message and commits it", async () => {
  writeFileSync(join(repo, "hello.ts"), "export const hello = () => 'pika';\n");
  mock.reply = "```\nfeat: add hello helper.\n```";
  const s = new Screen(["commit"], { env: env(), cwd: repo, cols: 110 });
  await s.waitFor("Stage all 1 changes", 20000);
  s.press("enter");
  await s.waitFor("feat: add hello helper", 20000);
  await s.waitFor("Use this message?");
  s.press("enter");
  await s.waitFor("Committed.", 20000);
  assert.equal(await s.waitExit(), 0);
  const log = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: repo }).toString().trim();
  assert.equal(log, "feat: add hello helper");
  const req = mock.requests.filter((r) => r.path === "/api/chat").pop();
  assert.match(req?.body.messages[1].content, /hello\.ts/);
});

test("commit --no-ai --yes uses the offline generator", async () => {
  writeFileSync(join(repo, "README.md"), "# demo\n\nMore docs.\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  const s = new Screen(["commit", "--no-ai", "--yes"], { env: env(), cwd: repo });
  await s.waitFor("Committed.", 20000);
  assert.equal(await s.waitExit(), 0);
  assert.equal(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: repo }).toString().trim(), "docs: update README.md");
});

test("explain combines the offline knowledge base with the AI", async () => {
  mock.reply = "**Cause:** a server is already running.\n\n**Fix:**\n1. Stop it.";
  const s = new Screen(["explain", "Error: listen EADDRINUSE: address already in use :::59998"], { env: env(), cols: 110 });
  await s.waitFor("Port 59998 is already in use", 20000);
  await s.waitFor("AI explanation", 20000);
  await s.waitFor("Stop it.", 20000);
  assert.equal(await s.waitExit(), 0);
});

test("interactive chat keeps the conversation", async () => {
  mock.reply = (body) => `You said: ${body.messages[body.messages.length - 1].content} (${body.messages.length} msgs)`;
  const s = new Screen([], { env: env(), cols: 100, rows: 40 });
  await s.waitFor("qwen3:4b · Ollama", 20000);
  s.write("first question");
  s.press("enter");
  await s.waitFor("You said: first question (2 msgs)", 20000);
  s.write("second one");
  s.press("enter");
  await s.waitFor("You said: second one (4 msgs)", 20000);
  s.press("ctrl+c");
  s.press("ctrl+c");
  assert.equal(await s.waitExit(), 0);
});

test("setup wizard saves the provider and model", async () => {
  const setupHome = mkdtempSync(join(os.tmpdir(), "pikaclow-setup-"));
  mock.reply = "pika pika!";
  const s = new Screen(["setup"], { env: { PIKACLOW_HOME: setupHome, PIKACLOW_LANG: "en", OLLAMA_HOST: mock.url }, cols: 110 });
  await s.waitFor("Language / Ngôn ngữ", 20000);
  s.press("enter"); // English
  await s.waitFor("Where should AI features run?");
  s.press("enter"); // Ollama
  await s.waitFor("Ollama address", 20000);
  s.press("ctrl+u");
  s.write(mock.url);
  s.press("enter");
  await s.waitFor("Which model?", 20000);
  s.press("enter"); // qwen3:4b
  await s.waitFor("Works", 20000);
  await s.waitFor("Language for generated commit messages?");
  s.press("down", "enter"); // Vietnamese
  await s.waitFor("All set!");
  assert.equal(await s.waitExit(), 0);
  const cfg = JSON.parse(readFileSync(join(setupHome, "config.json"), "utf8"));
  assert.deepEqual(cfg, { lang: "en", ai: { provider: "ollama", baseUrl: mock.url, model: "qwen3:4b" }, commitLang: "vi" });
  rmSync(setupHome, { recursive: true, force: true });
});

test("models shows the runtime, installed models and recommendations", async () => {
  const s = new Screen(["models"], { env: { ...env(), PIKACLOW_MODEL: "" }, cols: 120, rows: 60 });
  await s.waitFor("Ollama 0.9.9-mock running", 30000);
  await s.waitFor("Recommended for you");
  await s.waitFor("Download or switch the default model?");
  s.press("esc");
  assert.equal(await s.waitExit(), 0);
});
