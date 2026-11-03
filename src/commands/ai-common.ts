import { AiError, readyProvider, type Provider } from "../core/ai/index.js";
import type { ChatMessage } from "../core/ai/provider.js";
import { t } from "../i18n/index.js";
import { MarkdownStream } from "../ui/markdown.js";
import { spinner, type Spinner } from "../ui/spinner.js";
import { isTTY, write } from "../ui/terminal.js";
import { c } from "../ui/theme.js";

/** Gets a ready provider, showing a spinner while Ollama/API is checked. */
export async function getProvider(quiet = false): Promise<Provider> {
  const s = quiet ? null : spinner(t("ai.connecting"));
  try {
    return await readyProvider();
  } finally {
    s?.stop();
  }
}

/**
 * Streams an answer as rendered Markdown. Shows a spinner until the first token
 * (models can take a while to load) and while the model is "thinking".
 */
export async function streamAnswer(provider: Provider, messages: ChatMessage[], signal: AbortSignal, opts: { temperature?: number } = {}): Promise<string> {
  const md = new MarkdownStream();
  let spin: Spinner | null = spinner(t("ai.waiting", { model: provider.model ?? "" }));
  const started = Date.now();
  const stopSpin = () => {
    spin?.stop();
    spin = null;
  };
  try {
    const text = await provider.chat(messages, {
      signal,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      onThinking: (on) => {
        if (on && !spin) spin = spinner(t("ai.thinking"));
        else if (on) spin?.update(t("ai.thinking"));
        else stopSpin();
      },
      onToken: (tok) => {
        stopSpin();
        md.push(tok);
      },
    });
    stopSpin();
    md.end();
    if (!text.trim()) throw new AiError(t("ai.empty"), undefined, "empty");
    if (isTTY()) write(c.faint(`  ${provider.model} · ${((Date.now() - started) / 1000).toFixed(1)}s`) + "\n");
    return text;
  } catch (e) {
    stopSpin();
    md.end();
    throw e;
  }
}

/** Runs a completion without streaming to screen (spinner only). */
export async function complete(provider: Provider, messages: ChatMessage[], signal: AbortSignal, label: string, temperature = 0.2): Promise<string> {
  const s = spinner(label);
  try {
    let n = 0;
    const text = await provider.chat(messages, {
      signal,
      temperature,
      onThinking: (on) => s.update(on ? t("ai.thinking") : label),
      onToken: (tok) => {
        n += tok.length;
        s.update(label + c.faint(`  ${n} chars`));
      },
    });
    return text;
  } finally {
    s.stop();
  }
}
