import os from "node:os";
import { AiError, aiLang, prompts } from "../core/ai/index.js";
import { tildify } from "../core/format.js";
import type { Ctx } from "../core/context.js";
import { onInterrupt } from "../core/context.js";
import { matchKnownErrors, type KnownError } from "../core/errors-kb.js";
import { killProcess, listPorts } from "../core/ports.js";
import { detectShell, runAndCapture } from "../core/shell.js";
import { t, tMaybe } from "../i18n/index.js";
import { box, cmd, status } from "../ui/components.js";
import { withKeyboardReleased } from "../ui/keys.js";
import { blank, print } from "../ui/print.js";
import { confirm, isCancel } from "../ui/prompts.js";
import { columns, isInteractive, write } from "../ui/terminal.js";
import { c, P, sym } from "../ui/theme.js";
import { stripAnsi } from "../ui/text.js";
import { getProvider, streamAnswer } from "./ai-common.js";

export interface ExplainOptions {
  ai?: boolean;
  always?: boolean;
  /** Shell to run the command in (the one that recorded it), instead of the detected one. */
  shell?: string;
}

async function readStdin(limit = 400_000): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
    if (data.length > limit) data = data.slice(-limit / 2);
  }
  return data;
}

/** Last N lines, which is where errors usually are. */
function tail(text: string, lines = 120, chars = 7000): string {
  const clean = stripAnsi(text).replace(/\r(?!\n)/g, "\n");
  let out = clean.split("\n").slice(-lines).join("\n");
  if (out.length > chars) out = "…\n" + out.slice(-chars);
  return out.trim();
}

async function showKnown(found: KnownError[], ctx: Ctx): Promise<{ freedPort: boolean }> {
  let freedPort = false;
  const w = Math.min(columns() - 2, 96);
  for (const k of found) {
    const title = tMaybe(`kb.${k.id}.title`, k.id, k.vars);
    const lines = [c.muted(tMaybe(`kb.${k.id}.why`, "", k.vars))].filter((l) => l.trim());
    for (const f of k.fixes) lines.push(c.brand(sym("pointerSmall")) + " " + cmd(f));
    if (k.action?.type === "kill-port") {
      const port = k.action.port;
      const holders = (await listPorts().catch(() => [])).filter((e) => e.port === port);
      for (const h of holders) {
        lines.push(c.muted(t("explain.heldBy", { name: h.process, pid: h.pid })) + (h.app ? c.faint(" · " + h.app) : "") + (h.project ? c.faint(" · " + tildify(h.project, os.homedir())) : ""));
      }
      print(...box(lines, { title: sym("bolt") + " " + title, width: w, color: P.warn, titleColor: P.warn }).map((l) => " " + l));
      if (holders.length && isInteractive()) {
        const ok = await confirm({ message: t("explain.freePort", { port }), initial: true, signal: ctx.signal });
        if (!isCancel(ok) && ok) {
          for (const h of holders) {
            const r = await killProcess(h.pid);
            print(" " + (r === "killed" || r === "gone" ? status.ok(t("ports.killed", { name: h.process, pid: h.pid, port })) : status.fail(t("ports.denied", { name: h.process, pid: h.pid }))));
            if (r === "killed" || r === "gone") freedPort = true;
          }
        }
      }
      continue;
    }
    print(...box(lines.length ? lines : [c.muted(title)], { title: sym("bolt") + " " + title, width: w, color: P.warn, titleColor: P.warn }).map((l) => " " + l));
  }
  return { freedPort };
}

export async function explainCommand(words: string[], opts: ExplainOptions, ctx: Ctx, command?: string[]): Promise<void> {
  await explain(words, opts, ctx, command);
}

/** Same as explainCommand; resolves to true when a command was run and succeeded. */
export async function explain(words: string[], opts: ExplainOptions, ctx: Ctx, command?: string[]): Promise<boolean> {
  const shell = detectShell(opts.shell);
  let output = "";
  let exitCode: number | null = null;
  let cmdLine = "";

  if (command && command.length) {
    cmdLine = command.join(" ");
    blank();
    print(c.faint(`${sym("pointer")} ${cmdLine}`));
    const off = onInterrupt(() => {});
    try {
      const r = await withKeyboardReleased(() => runAndCapture(cmdLine, shell, (d) => write(d)));
      output = r.output;
      exitCode = r.code;
    } finally {
      off();
    }
    blank();
    if (exitCode === 0 && !opts.always) {
      print(status.ok(t("explain.succeeded")));
      blank();
      return true;
    }
    print(status.fail(t("explain.failedWith", { code: String(exitCode ?? "?") })));
  } else if (!process.stdin.isTTY) {
    output = await readStdin();
  } else if (words.length) {
    output = words.join(" ");
  } else {
    blank();
    print(" " + t("explain.usage"));
    print("   " + cmd("pikaclow explain -- npm run build"));
    print("   " + cmd("npm test 2>&1 | pikaclow explain"));
    print("   " + cmd('pikaclow explain "Error: listen EADDRINUSE :::3000"'));
    blank();
    return false;
  }

  if (!output.trim()) {
    print(status.warn(t("explain.noOutput")));
    return false;
  }

  blank();
  const known = matchKnownErrors(output);
  const { freedPort } = await showKnown(known, ctx);

  // A port was freed: offer to run the command again right away.
  if (freedPort && cmdLine && isInteractive()) {
    const again = await confirm({ message: t("explain.rerun", { cmd: cmdLine }), initial: true, signal: ctx.signal });
    if (!isCancel(again) && again) return explain([], opts, ctx, command);
  }

  if (opts.ai === false) {
    if (!known.length) print(status.hint(t("explain.noKnown")));
    blank();
    return false;
  }
  try {
    const provider = await getProvider(true);
    blank();
    print(" " + c.brandBold(sym("bolt") + " " + t("explain.aiTitle")));
    blank();
    const user = [
      cmdLine ? `Command: ${cmdLine}` : "",
      exitCode !== null ? `Exit code: ${exitCode}` : "",
      known.length ? `Already detected: ${known.map((k) => k.id).join(", ")}` : "",
      "Output (last lines):\n```\n" + tail(output) + "\n```",
    ]
      .filter(Boolean)
      .join("\n");
    await streamAnswer(
      provider,
      [
        { role: "system", content: prompts.explain(aiLang(), shell) },
        { role: "user", content: user },
      ],
      ctx.signal,
    );
  } catch (e) {
    if (e instanceof AiError && e.code !== "aborted") {
      if (!known.length) {
        print(status.warn(e.message));
        if (e.hint) print(c.faint("  " + e.hint));
      } else print(status.hint(t("explain.aiTip", { cmd: cmd("pikaclow setup") })));
    } else throw e;
  }
  blank();
  return false;
}
