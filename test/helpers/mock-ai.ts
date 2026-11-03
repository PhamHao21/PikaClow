// A fake AI server speaking both Ollama's API and the OpenAI Chat Completions API,
// so AI features can be tested end-to-end without a real model.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockAi {
  url: string;
  requests: { path: string; body: any }[];
  /** Reply for the next chat call(s). A function gets the request body. */
  reply: string | ((body: any) => string);
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Splits text into small chunks, like a model streaming tokens. */
function chunks(text: string): string[] {
  return text.match(/.{1,4}/gs) ?? [];
}

export async function startMockAi(opts: { models?: string[]; reply?: string } = {}): Promise<MockAi> {
  const models = opts.models ?? ["qwen3:4b", "llama3.2:3b"];
  const mock: MockAi = {
    url: "",
    requests: [],
    reply: opts.reply ?? "Hello from the mock model!",
    close: () => new Promise((r) => server.close(() => r())),
  };
  const replyFor = (body: any) => (typeof mock.reply === "function" ? mock.reply(body) : mock.reply);
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? "").replace(/\?.*$/, "");
    mock.requests.push({ path, body });
    // ── Ollama ──
    if (path === "/api/version") return void res.end(JSON.stringify({ version: "0.9.9-mock" }));
    if (path === "/api/tags") {
      return void res.end(JSON.stringify({ models: models.map((name) => ({ name, size: 2.5 * 1024 ** 3, details: { parameter_size: "4.0B", quantization_level: "Q4_K_M", family: "qwen3" } })) }));
    }
    if (path === "/api/chat") {
      if (!models.includes(body.model)) {
        res.statusCode = 404;
        return void res.end(JSON.stringify({ error: `model '${body.model}' not found` }));
      }
      res.setHeader("content-type", "application/x-ndjson");
      // Include a reasoning block to prove it gets filtered out.
      const parts = ["<thi", "nk>secret reasoning</th", "ink>", ...chunks(replyFor(body))];
      for (const p of parts) {
        res.write(JSON.stringify({ message: { role: "assistant", content: p }, done: false }) + "\n");
        await new Promise((r) => setTimeout(r, 2));
      }
      return void res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
    }
    if (path === "/api/pull") {
      res.setHeader("content-type", "application/x-ndjson");
      for (let i = 0; i <= 4; i++) res.write(JSON.stringify({ status: "pulling abc", total: 100, completed: i * 25 }) + "\n");
      return void res.end(JSON.stringify({ status: "success" }) + "\n");
    }
    // ── OpenAI-compatible ──
    if (path === "/v1/models") {
      if (req.headers.authorization !== "Bearer test-key") {
        res.statusCode = 401;
        return void res.end(JSON.stringify({ error: { message: "bad key" } }));
      }
      return void res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    }
    if (path === "/v1/chat/completions") {
      if (req.headers.authorization !== "Bearer test-key") {
        res.statusCode = 401;
        return void res.end(JSON.stringify({ error: { message: "bad key" } }));
      }
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}\n\n`);
      for (const p of chunks(replyFor(body))) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
      }
      return void res.end("data: [DONE]\n\n");
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}
