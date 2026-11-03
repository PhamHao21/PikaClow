import os from "node:os";
import { loadConfig, type Lang } from "../config.js";
import { currentBranch, findRepoRoot } from "../git.js";
import { osName } from "../system/info.js";
import { detectShell, type ShellInfo } from "../shell.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAiProvider } from "./openai.js";
import { AiError, resolveAiConfig, type ModelInfo, type Provider } from "./provider.js";

export { AiError } from "./provider.js";
export type { ChatMessage, Provider, ModelInfo } from "./provider.js";

export function createProvider(): Provider {
  const cfg = resolveAiConfig();
  if (cfg.provider === "openai") {
    const key =
      cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? process.env.PIKACLOW_API_KEY ?? process.env.OPENAI_API_KEY;
    return new OpenAiProvider(cfg.baseUrl ?? "https://api.openai.com/v1", cfg.model, key);
  }
  return new OllamaProvider(cfg.baseUrl, cfg.model);
}

const EMBEDDING = /embed|bge-|all-minilm|mxbai|snowflake-arctic-embed|granite-embedding|nomic/i;
const PREFERENCE = ["qwen3", "gemma3", "qwen2.5", "llama3.2", "phi4-mini", "llama3.1", "gpt-oss", "mistral", "gemma2", "phi3", "deepseek-r1"];

/** Chooses a sensible chat model among installed ones when none is configured. */
export function pickDefaultModel(models: ModelInfo[]): string | undefined {
  const chat = models.filter((m) => !EMBEDDING.test(m.name));
  if (chat.length <= 1) return chat[0]?.name;
  for (const family of PREFERENCE) {
    const hits = chat.filter((m) => m.name.startsWith(family)).sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    // Prefer a mid-sized variant: the largest under ~6 GB, else the smallest.
    const mid = hits.filter((m) => (m.size ?? 0) < 6.5 * 1024 ** 3).pop() ?? hits[0];
    if (mid) return mid.name;
  }
  return chat[0]?.name;
}

/** Provider that is reachable and has a model, or a friendly AiError. */
export async function readyProvider(): Promise<Provider> {
  const p = createProvider();
  if (p instanceof OllamaProvider) {
    const st = await p.status();
    if (!st.ok) throw p.offline();
    if (!p.model) {
      const pick = pickDefaultModel(await p.models());
      if (!pick) throw new AiError("No models installed in Ollama yet.", "Run: pikaclow models   (pick one to download)", "no-model");
      p.model = pick;
    }
  } else if (!p.model) {
    throw new AiError("No model selected.", "Run: pikaclow setup", "no-model");
  }
  return p;
}

export function aiLang(): Lang {
  return loadConfig().lang ?? "en";
}

export function langInstruction(lang: Lang): string {
  return lang === "vi"
    ? "Always answer in Vietnamese (tiếng Việt, có dấu), but keep code, commands, file names and technical identifiers unchanged."
    : "Answer in English.";
}

/** A short description of the user's environment, given to the model as context. */
export function environmentContext(shell: ShellInfo = detectShell()): string {
  const root = findRepoRoot();
  const branch = root ? currentBranch(root) : null;
  const lines = [
    `OS: ${osName()} (${process.platform}/${os.arch()})`,
    `Shell: ${shell.label}`,
    `Working directory: ${process.cwd()}`,
    `Node.js: ${process.version}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
  ];
  if (root) lines.push(`Git repository: ${root}${branch ? ` (branch ${branch})` : ""}`);
  return lines.join("\n");
}

export const prompts = {
  chat(lang: Lang, shell: ShellInfo): string {
    return [
      "You are PikaClow, a friendly and sharp terminal assistant for software developers.",
      "Be concise and practical: short paragraphs, bullet points, and exact commands in fenced code blocks.",
      `When you suggest shell commands, write them for ${shell.label} on this machine.`,
      "Never claim you ran a command. If you are unsure, say so.",
      langInstruction(lang),
      "",
      "Environment:",
      environmentContext(shell),
    ].join("\n");
  },

  shell(lang: Lang, shell: ShellInfo): string {
    return [
      `You translate a task description into ONE command for ${shell.label} on ${osName()}.`,
      "Rules:",
      "- Prefer built-in tools of that shell; avoid installing software.",
      "- A single line. Chain steps with the shell's own separator if needed.",
      "- No placeholders like <file> unless the task is truly ambiguous.",
      "- Never add destructive flags the task did not ask for.",
      "Reply in exactly this format and nothing else:",
      "COMMAND: <the command>",
      `EXPLAIN: <one short sentence${lang === "vi" ? " in Vietnamese" : ""} saying what it does>`,
      "",
      "Environment:",
      environmentContext(shell),
    ].join("\n");
  },

  commit(lang: Lang): string {
    return [
      "You write git commit messages from a staged diff.",
      "Format: Conventional Commits. First line: type(optional-scope): subject",
      "Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore.",
      "Subject: imperative mood, at most 72 characters, no trailing period.",
      "If useful, add a blank line and 1-4 short bullet lines starting with \"- \" describing the main changes.",
      lang === "vi"
        ? "Write the subject and bullets in Vietnamese (có dấu); keep the type(scope): prefix in English."
        : "Write in English.",
      "Output ONLY the commit message: no code fences, no quotes, no explanations.",
    ].join("\n");
  },

  explain(lang: Lang, shell: ShellInfo): string {
    return [
      "You are a senior developer helping someone who just hit an error in the terminal.",
      "Explain the most likely cause and the fix. Be specific to the output; do not list generic advice.",
      "Format in Markdown:",
      "**Cause:** 1-2 sentences.",
      "**Fix:** numbered steps, with exact commands in code blocks for " + shell.label + ".",
      "Keep it under 180 words.",
      langInstruction(lang),
      "",
      "Environment:",
      environmentContext(shell),
    ].join("\n");
  },
};

/** Pulls COMMAND/EXPLAIN out of a model reply, tolerating code fences and chatter. */
export function parseShellReply(reply: string): { command: string; explanation: string } {
  const text = reply.replace(/\r/g, "").trim();
  const cmd = /^\s*(?:\*\*)?COMMAND(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/im.exec(text);
  const exp = /^\s*(?:\*\*)?EXPLAIN(?:ATION)?(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/im.exec(text);
  let command = cmd?.[1]?.trim() ?? "";
  if (!command) {
    const fence = /```[\w-]*\n([\s\S]*?)```/.exec(text);
    command = fence?.[1]?.trim().split("\n")[0] ?? text.split("\n").find((l) => l.trim()) ?? "";
  }
  command = command.replace(/^`+|`+$/g, "").replace(/^\$\s+/, "").replace(/^PS [^>]*>\s*/, "").trim();
  return { command, explanation: exp?.[1]?.trim() ?? "" };
}

/** Cleans a generated commit message (fences, quotes, prefixes). */
export function cleanCommitMessage(reply: string): string {
  let t = reply.replace(/\r/g, "").trim();
  t = t.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
  t = t.replace(/^(commit message|message)\s*:\s*/i, "");
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
  const lines = t.split("\n");
  if (lines[0]) lines[0] = lines[0].replace(/\.$/, "").trim();
  // Ensure a blank line between subject and body.
  if (lines.length > 1 && lines[1]!.trim() !== "") lines.splice(1, 0, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
