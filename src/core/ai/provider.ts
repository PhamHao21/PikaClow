import { loadConfig, type AiConfig } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Called with visible text as it streams (reasoning is filtered out). */
  onToken?: (text: string) => void;
  /** Called when the model starts/stops a hidden reasoning phase. */
  onThinking?: (active: boolean) => void;
}

export interface ModelInfo {
  name: string;
  size?: number;
  parameters?: string;
  quantization?: string;
  family?: string;
}

export interface ProviderStatus {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface Provider {
  kind: "ollama" | "openai";
  label: string;
  baseUrl: string;
  model: string | undefined;
  status(): Promise<ProviderStatus>;
  models(): Promise<ModelInfo[]>;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

/** Error with a message meant for the user and an optional next step. */
export class AiError extends Error {
  constructor(
    message: string,
    public hint?: string,
    public code: "offline" | "no-model" | "model-missing" | "auth" | "rate" | "http" | "aborted" | "empty" = "http",
  ) {
    super(message);
    this.name = "AiError";
  }
}

/**
 * Strips reasoning blocks (<think>…</think>) from streamed text. Tags may be split
 * across chunks, so a possible partial tag at the end is held back.
 */
export class ThinkFilter {
  private buf = "";
  thinking = false;
  sawThinking = false;

  push(text: string): string {
    this.buf += text;
    let out = "";
    for (;;) {
      if (this.thinking) {
        const end = this.buf.indexOf("</think>");
        if (end < 0) {
          this.buf = this.buf.slice(Math.max(0, this.buf.length - 7));
          return out;
        }
        this.buf = this.buf.slice(end + 8);
        this.thinking = false;
        continue;
      }
      const start = this.buf.indexOf("<think>");
      if (start >= 0) {
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.thinking = true;
        this.sawThinking = true;
        continue;
      }
      // Hold back a trailing fragment that could be the beginning of "<think>".
      let keep = 0;
      for (let k = Math.min(6, this.buf.length); k > 0; k--) {
        if ("<think>".startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      out += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  flush(): string {
    const rest = this.thinking ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

/** Reads a fetch body line by line. */
export async function* readLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new AiError("Cancelled", undefined, "aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield buf;
  } finally {
    reader.releaseLock();
  }
}

export function resolveAiConfig(): AiConfig {
  const cfg = loadConfig().ai;
  const env = process.env;
  const provider = (env.PIKACLOW_PROVIDER as AiConfig["provider"] | undefined) ?? cfg?.provider ?? "ollama";
  const out: AiConfig = { provider };
  const model = env.PIKACLOW_MODEL ?? cfg?.model;
  if (model) out.model = model;
  const baseUrl = env.PIKACLOW_BASE_URL ?? cfg?.baseUrl;
  if (baseUrl) out.baseUrl = baseUrl;
  if (cfg?.apiKeyEnv) out.apiKeyEnv = cfg.apiKeyEnv;
  if (cfg?.apiKey) out.apiKey = cfg.apiKey;
  return out;
}
