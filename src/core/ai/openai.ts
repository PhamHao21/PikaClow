import { AiError, readLines, ThinkFilter, type ChatMessage, type ChatOptions, type ModelInfo, type Provider, type ProviderStatus } from "./provider.js";

/**
 * Any OpenAI-compatible Chat Completions endpoint: LM Studio, llama.cpp server, vLLM,
 * OpenRouter, Groq, DeepSeek, OpenAI, Gemini's OpenAI endpoint… (streams SSE).
 */
export class OpenAiProvider implements Provider {
  kind = "openai" as const;
  label: string;
  baseUrl: string;

  constructor(
    baseUrl: string,
    public model: string | undefined,
    private apiKey: string | undefined,
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    this.label = labelFor(this.baseUrl);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private httpError(status: number, body: string): AiError {
    let msg = body;
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string };
      msg = typeof j.error === "string" ? j.error : (j.error?.message ?? body);
    } catch {
      // keep raw text
    }
    if (status === 401 || status === 403) return new AiError(`${this.label}: invalid or missing API key.`, "Run: pikaclow setup", "auth");
    if (status === 404) return new AiError(`${this.label}: model "${this.model}" not found.`, "Run: pikaclow setup", "model-missing");
    if (status === 429) return new AiError(`${this.label}: rate limited. Try again in a moment.`, undefined, "rate");
    return new AiError(`${this.label}: ${msg.slice(0, 300) || "HTTP " + status}`);
  }

  async status(): Promise<ProviderStatus> {
    try {
      const r = await fetch(this.baseUrl + "/models", { headers: this.headers(), signal: AbortSignal.timeout(4000) });
      if (r.status === 401 || r.status === 403) return { ok: false, error: "invalid API key" };
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async models(): Promise<ModelInfo[]> {
    let r: Response;
    try {
      r = await fetch(this.baseUrl + "/models", { headers: this.headers(), signal: AbortSignal.timeout(6000) });
    } catch {
      throw new AiError(`Cannot reach ${this.baseUrl}.`, "Check the URL with: pikaclow setup", "offline");
    }
    if (!r.ok) throw this.httpError(r.status, await r.text().catch(() => ""));
    const j = (await r.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => ({ name: m.id })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    if (!this.model) throw new AiError("No model selected.", "Run: pikaclow setup", "no-model");
    let res: Response;
    try {
      res = await fetch(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          temperature: opts.temperature ?? 0.3,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch {
      if (opts.signal?.aborted) throw new AiError("Cancelled", undefined, "aborted");
      throw new AiError(`Cannot reach ${this.baseUrl}.`, "Check the URL with: pikaclow setup", "offline");
    }
    if (!res.ok || !res.body) throw this.httpError(res.status, await res.text().catch(() => ""));
    const filter = new ThinkFilter();
    let text = "";
    let thinking = false;
    const setThinking = (on: boolean) => {
      if (on !== thinking) {
        thinking = on;
        opts.onThinking?.(on);
      }
    };
    try {
      for await (const line of readLines(res.body, opts.signal)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break;
        let j: { choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[]; error?: { message?: string } };
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new AiError(`${this.label}: ${j.error.message ?? "error"}`);
        const delta = j.choices?.[0]?.delta;
        if (delta?.reasoning_content || delta?.reasoning) setThinking(true);
        const piece = delta?.content ?? "";
        if (piece) {
          const visible = filter.push(piece);
          setThinking(filter.thinking);
          if (visible) {
            text += visible;
            opts.onToken?.(visible);
          }
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) throw new AiError("Cancelled", undefined, "aborted");
      throw e;
    }
    const rest = filter.flush();
    if (rest) {
      text += rest;
      opts.onToken?.(rest);
    }
    setThinking(false);
    return text;
  }
}

function labelFor(url: string): string {
  const known: [RegExp, string][] = [
    [/api\.openai\.com/, "OpenAI"],
    [/openrouter\.ai/, "OpenRouter"],
    [/api\.groq\.com/, "Groq"],
    [/api\.deepseek\.com/, "DeepSeek"],
    [/generativelanguage\.googleapis\.com/, "Gemini"],
    [/api\.mistral\.ai/, "Mistral"],
    [/api\.together\.xyz/, "Together"],
    [/:1234\b/, "LM Studio"],
    [/:8080\b/, "llama.cpp"],
    [/:11434\b/, "Ollama (OpenAI API)"],
  ];
  for (const [re, name] of known) if (re.test(url)) return name;
  try {
    return new URL(url).host;
  } catch {
    return "OpenAI-compatible";
  }
}
