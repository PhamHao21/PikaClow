import { AiError, readLines, ThinkFilter, type ChatMessage, type ChatOptions, type ModelInfo, type Provider, type ProviderStatus } from "./provider.js";

export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  return u;
}

/** Ollama's native API (streams NDJSON). https://github.com/ollama/ollama/blob/main/docs/api.md */
export class OllamaProvider implements Provider {
  kind = "ollama" as const;
  label = "Ollama";
  baseUrl: string;

  constructor(
    baseUrl: string | undefined,
    public model: string | undefined,
  ) {
    this.baseUrl = normalizeUrl(baseUrl ?? process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL);
  }

  async status(): Promise<ProviderStatus> {
    try {
      const r = await fetch(this.baseUrl + "/api/version", { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = (await r.json()) as { version?: string };
      return j.version ? { ok: true, version: j.version } : { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async models(): Promise<ModelInfo[]> {
    let r: Response;
    try {
      r = await fetch(this.baseUrl + "/api/tags", { signal: AbortSignal.timeout(4000) });
    } catch {
      throw this.offline();
    }
    if (!r.ok) throw new AiError(`Ollama: HTTP ${r.status}`);
    const j = (await r.json()) as {
      models?: { name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string; family?: string } }[];
    };
    return (j.models ?? []).map((m) => {
      const info: ModelInfo = { name: m.name };
      if (m.size) info.size = m.size;
      if (m.details?.parameter_size) info.parameters = m.details.parameter_size;
      if (m.details?.quantization_level) info.quantization = m.details.quantization_level;
      if (m.details?.family) info.family = m.details.family;
      return info;
    });
  }

  offline(): AiError {
    return new AiError(`Ollama is not running at ${this.baseUrl}.`, "Install it from https://ollama.com/download, start it, then run: pikaclow models", "offline");
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    if (!this.model) throw new AiError("No model selected.", "Run: pikaclow models   (or pikaclow setup)", "no-model");
    let res: Response;
    try {
      res = await fetch(this.baseUrl + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          keep_alive: "10m",
          options: { temperature: opts.temperature ?? 0.3, ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}) },
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw new AiError("Cancelled", undefined, "aborted");
      throw this.offline();
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // not JSON
      }
      if (res.status === 404 || /not found/i.test(msg)) {
        throw new AiError(`Model "${this.model}" is not installed in Ollama.`, `Run: ollama pull ${this.model}   (or pikaclow models)`, "model-missing");
      }
      throw new AiError(`Ollama error: ${msg || "HTTP " + res.status}`);
    }
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
        if (!line.trim()) continue;
        let j: { message?: { content?: string; thinking?: string }; done?: boolean; error?: string };
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.error) throw new AiError(`Ollama error: ${j.error}`);
        if (j.message?.thinking) setThinking(true);
        const piece = j.message?.content ?? "";
        if (piece) {
          const visible = filter.push(piece);
          setThinking(filter.thinking);
          if (visible) {
            text += visible;
            opts.onToken?.(visible);
          }
        }
        if (j.done) break;
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

  /** Downloads a model, reporting progress (0..1). */
  async pull(name: string, onProgress: (status: string, fraction: number | null) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + "/api/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name, stream: true }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw new AiError("Cancelled", undefined, "aborted");
      throw this.offline();
    }
    if (!res.ok || !res.body) throw new AiError(`Ollama pull failed: HTTP ${res.status}`);
    for await (const line of readLines(res.body, signal)) {
      if (!line.trim()) continue;
      let j: { status?: string; total?: number; completed?: number; error?: string };
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.error) throw new AiError(`Ollama: ${j.error}`);
      onProgress(j.status ?? "", j.total && j.completed !== undefined ? j.completed / j.total : null);
    }
  }
}
