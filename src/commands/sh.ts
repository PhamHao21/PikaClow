import { aiLang, parseShellReply, prompts } from "../core/ai/index.js";
import type { Ctx } from "../core/context.js";
import { onInterrupt } from "../core/context.js";
import { assessCommand, type RiskReport } from "../core/safety.js";
import { copyToClipboard, detectShell, runInShell, type ShellInfo } from "../core/shell.js";
import { t, tMaybe } from "../i18n/index.js";
import { box, titleBlock, status } from "../ui/components.js";
import { withKeyboardReleased } from "../ui/keys.js";
import { blank, print } from "../ui/print.js";
import { input, isCancel, select } from "../ui/prompts.js";
import { columns, isInteractive, isTTY, write } from "../ui/terminal.js";
import { c, P, sym } from "../ui/theme.js";
import { complete, getProvider } from "./ai-common.js";

export interface ShOptions {
  shell?: string;
  run?: boolean;
  copy?: boolean;
}

function riskLines(risk: RiskReport): string[] {
  if (risk.level === "safe") return [status.ok(t("sh.safe"))];
  const danger = risk.level === "danger";
  const title = danger ? t("sh.danger") : t("sh.caution");
  const head = c.tile(sym("warn"), danger ? P.err : P.warn) + " " + (danger ? c.err(title) : c.warn(title));
  return [head, ...risk.reasons.map((r) => "    " + (danger ? c.err(sym("bullet")) : c.warn(sym("bullet"))) + " " + c.muted(tMaybe("risk." + r, r)))];
}

/** Runs a command line in the user's shell with the terminal handed over to it. */
export async function runCommandLine(command: string, shell: ShellInfo): Promise<number | null> {
  blank();
  print(c.faint(`${sym("pointer")} ${command}`));
  // The child owns Ctrl+C while it runs; we just wait for it.
  const off = onInterrupt(() => {});
  try {
    return await withKeyboardReleased(() => runInShell(command, shell));
  } finally {
    off();
  }
}

export async function shCommand(words: string[], opts: ShOptions, ctx: Ctx): Promise<void> {
  const shell = detectShell(opts.shell);
  let task = words.join(" ").trim();
  if (!task) {
    if (!isInteractive()) throw new Error(t("sh.needTask"));
    const r = await input({ message: t("sh.askTask"), placeholder: t("sh.placeholder"), signal: ctx.signal });
    if (isCancel(r) || !r.trim()) return;
    task = r.trim();
  }

  const provider = await getProvider(!isTTY());
  const reply = await complete(
    provider,
    [
      { role: "system", content: prompts.shell(aiLang(), shell) },
      { role: "user", content: task },
    ],
    ctx.signal,
    t("sh.thinking", { model: provider.model ?? "" }),
    0.1,
  );
  let { command, explanation } = parseShellReply(reply);
  if (!command) throw new Error(t("sh.noCommand"));

  // Piped: print only the command so it can be captured.
  if (!isTTY()) {
    write(command + "\n");
    return;
  }

  for (;;) {
    const risk = assessCommand(command);
    const w = Math.min(columns() - 2, 100);
    blank();
    print(...titleBlock("SHELL", shell.label));
    const tone = risk.level === "danger" ? P.err : risk.level === "caution" ? P.warn : P.ok;
    print(...box([c.brandBold(command)], { width: w, title: t(`sh.badge.${risk.level}` as "sh.badge.safe"), color: risk.level === "safe" ? P.border : tone, titleColor: tone }).map((l) => " " + l));
    if (explanation) print("  " + c.muted(explanation));
    print(...riskLines(risk).map((l) => "  " + l));
    blank();

    if (opts.copy) {
      const ok = await copyToClipboard(command);
      print(" " + (ok ? status.ok(t("sh.copied")) : status.warn(t("sh.copyFailed"))));
      return;
    }
    let choice: string;
    if (opts.run && risk.level === "safe") choice = "run";
    else if (!isInteractive()) return;
    else {
      const r = await select({
        message: t("sh.what"),
        options: [
          { value: "run", label: t("sh.doRun"), hint: risk.level === "danger" ? t("sh.typeYes") : "" },
          { value: "copy", label: t("sh.doCopy") },
          { value: "edit", label: t("sh.doEdit") },
          { value: "cancel", label: t("sh.doCancel") },
        ],
        signal: ctx.signal,
      });
      if (isCancel(r)) return;
      choice = r;
    }
    if (choice === "cancel") return;
    if (choice === "copy") {
      const ok = await copyToClipboard(command);
      print(" " + (ok ? status.ok(t("sh.copied")) : status.warn(t("sh.copyFailed"))));
      blank();
      return;
    }
    if (choice === "edit") {
      const r = await input({ message: t("sh.editPrompt"), initial: command, signal: ctx.signal });
      if (isCancel(r) || !r.trim()) return;
      command = r.trim();
      explanation = "";
      continue;
    }
    if (risk.level === "danger") {
      const r = await input({
        message: t("sh.confirmDanger"),
        placeholder: "yes",
        validate: (v) => (v.trim().toLowerCase() === "yes" ? undefined : t("sh.mustTypeYes")),
        signal: ctx.signal,
      });
      if (isCancel(r)) return;
    }
    const code = await runCommandLine(command, shell);
    blank();
    print(code === 0 ? status.ok(t("sh.exitOk")) : status.warn(t("sh.exitCode", { code: String(code ?? "?") })));
    blank();
    return;
  }
}
