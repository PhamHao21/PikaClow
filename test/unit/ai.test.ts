import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { cleanCommitMessage, parseShellReply, pickDefaultModel } from "../../src/core/ai/index.js";
import { AiError, ThinkFilter } from "../../src/core/ai/provider.js";
import { OllamaProvider } from "../../src/core/ai/ollama.js";
import { OpenAiProvider } from "../../src/core/ai/openai.js";
import { startMockAi, type MockAi } from "../helpers/mock-ai.js";

test("ThinkFilter hides reasoning even when tags are split across chunks", () => {
  const f = new ThinkFilter();
  const out = ["Hi <th", "ink>secret", " stuff</thi", "nk> there", " <", "b>ok"].map((c) => f.push(c)).join("") + f.flush();
  assert.equal(out, "Hi  there <b>ok");
  assert.ok(f.sawThinking);
});

test("parseShellReply handles the strict format, code fences and prompts", () => {
  assert.deepEqual(parseShellReply("COMMAND: Get-ChildItem -File\nEXPLAIN: Lists files."), { command: "Get-ChildItem -File", explanation: "Lists files." });
  assert.equal(parseShellReply("Sure!\n```bash\n$ ls -la\n```").command, "ls -la");
  assert.equal(parseShellReply("**COMMAND:** `git log --oneline`").command, "git log --oneline");
  assert.equal(parseShellReply("PS C:\\> Get-Date").command, "Get-Date");
});

test("cleanCommitMessage strips fences, quotes and trailing periods", () => {
  assert.equal(cleanCommitMessage('```\n"feat: add login."\n```'), "feat: add login");
  assert.equal(cleanCommitMessage("Commit message: fix(api): handle nulls\n- guard input"), "fix(api): handle nulls\n\n- guard input");
});

test("pickDefaultModel prefers a mid-sized chat model and skips embeddings", () => {
  const GB = 1024 ** 3;
  assert.equal(
    pickDefaultModel([
      { name: "nomic-embed-text", size: 0.3 * GB },
      { name: "qwen3:14b", size: 9 * GB },
      { name: "qwen3:4b", size: 2.5 * GB },
      { name: "llama3.2:1b", size: 1.3 * GB },
    ]),
    "qwen3:4b",
  );
  assert.equal(pickDefaultModel([{ name: "nomic-embed-text" }]), undefined);
});

let mock: MockAi;
before(async () => {
  mock = await startMockAi({ reply: "Xin chào! **Pika** here." });
});
after(async () => {
  await mock.close();
});

test("Ollama provider streams text and filters reasoning", async () => {
  const p = new OllamaProvider(mock.url, "qwen3:4b");
  assert.deepEqual(await p.status(), { ok: true, version: "0.9.9-mock" });
  assert.deepEqual((await p.models()).map((m) => m.name), ["qwen3:4b", "llama3.2:3b"]);
  const tokens: string[] = [];
  const thinking: boolean[] = [];
  const text = await p.chat([{ role: "user", content: "hi" }], { onToken: (t) => tokens.push(t), onThinking: (on) => thinking.push(on) });
  assert.equal(text, "Xin chào! **Pika** here.");
  assert.ok(tokens.length > 3, "streamed in pieces");
  assert.deepEqual(thinking, [true, false]);
});

test("Ollama provider explains a missing model", async () => {
  const p = new OllamaProvider(mock.url, "nope:1b");
  await assert.rejects(p.chat([{ role: "user", content: "hi" }]), (e: unknown) => e instanceof AiError && e.code === "model-missing" && /ollama pull nope:1b/.test(e.hint ?? ""));
});

test("Ollama provider reports offline clearly", async () => {
  const p = new OllamaProvider("http://127.0.0.1:9", "qwen3:4b");
  assert.equal((await p.status()).ok, false);
  await assert.rejects(p.chat([{ role: "user", content: "hi" }]), (e: unknown) => e instanceof AiError && e.code === "offline");
});

test("Ollama pull reports progress", async () => {
  const p = new OllamaProvider(mock.url, undefined);
  const seen: (number | null)[] = [];
  await p.pull("qwen3:4b", (_s, f) => seen.push(f));
  assert.equal(seen.filter((x) => x === 1).length, 1);
});

test("OpenAI-compatible provider streams SSE and checks the key", async () => {
  const ok = new OpenAiProvider(mock.url + "/v1", "qwen3:4b", "test-key");
  assert.equal(await ok.chat([{ role: "user", content: "hi" }]), "Xin chào! **Pika** here.");
  assert.deepEqual((await ok.models()).map((m) => m.name), ["llama3.2:3b", "qwen3:4b"]);
  const bad = new OpenAiProvider(mock.url + "/v1", "qwen3:4b", "wrong");
  await assert.rejects(bad.chat([{ role: "user", content: "hi" }]), (e: unknown) => e instanceof AiError && e.code === "auth");
});

test("chat can be cancelled", async () => {
  const p = new OllamaProvider(mock.url, "qwen3:4b");
  const ac = new AbortController();
  mock.reply = "x".repeat(4000);
  const promise = p.chat([{ role: "user", content: "hi" }], { signal: ac.signal, onToken: () => ac.abort() });
  await assert.rejects(promise, (e: unknown) => e instanceof AiError && e.code === "aborted");
  mock.reply = "Xin chào! **Pika** here.";
});
