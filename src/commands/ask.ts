import { aiLang, prompts } from "../core/ai/index.js";
import type { Ctx } from "../core/context.js";
import { detectShell } from "../core/shell.js";
import { t } from "../i18n/index.js";
import { blank, print } from "../ui/print.js";
import { input, isCancel } from "../ui/prompts.js";
import { isInteractive } from "../ui/terminal.js";
import { getProvider, streamAnswer } from "./ai-common.js";

async function readStdin(limit = 200_000): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
    if (data.length > limit) break;
  }
  return data.slice(0, limit);
}

/** One-shot question. Piped input is attached as context: `cat log.txt | pikaclow ask "why?"` */
export async function askCommand(words: string[], ctx: Ctx): Promise<void> {
  let question = words.join(" ").trim();
  const piped = !process.stdin.isTTY ? await readStdin() : "";
  if (!question && !piped) {
    if (!isInteractive()) throw new Error(t("ask.needQuestion"));
    const r = await input({ message: t("ask.prompt"), signal: ctx.signal });
    if (isCancel(r) || !r.trim()) return;
    question = r.trim();
  }
  const provider = await getProvider();
  const content = piped ? `${question || "Explain this:"}\n\n\`\`\`\n${piped}\n\`\`\`` : question;
  blank();
  await streamAnswer(
    provider,
    [
      { role: "system", content: prompts.chat(aiLang(), detectShell()) },
      { role: "user", content },
    ],
    ctx.signal,
  );
  print("");
}
