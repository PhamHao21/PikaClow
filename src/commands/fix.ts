import { existsSync } from "node:fs";
import os from "node:os";
import type { Ctx } from "../core/context.js";
import { tildify } from "../core/format.js";
import { clearLastFailed, hookShellFor, isHookInstalled, readLastFailed, type FailedCommand } from "../core/hook.js";
import { assessCommand } from "../core/safety.js";
import { detectShell } from "../core/shell.js";
import { t } from "../i18n/index.js";
import { box, cmd, status, titleBlock } from "../ui/components.js";
import { blank, print } from "../ui/print.js";
import { input, isCancel, select } from "../ui/prompts.js";
import { columns, isInteractive } from "../ui/terminal.js";
import { c, P, sym } from "../ui/theme.js";
import { explain, explainCommand } from "./explain.js";

export interface FixOptions {
  yes?: boolean;
  ai?: boolean;
}

function ago(at: number): string {
  const min = Math.floor((Date.now() - at) / 60000);
  if (min < 1) return t("fix.justNow");
  if (min < 60) return t("fix.minAgo", { n: min });
  if (min < 48 * 60) return t("fix.hoursAgo", { n: Math.floor(min / 60) });
  return t("fix.daysAgo", { n: Math.floor(min / 1440) });
}

async function explainOnly(f: FailedCommand, opts: FixOptions, ctx: Ctx): Promise<void> {
  const note = t("fix.notCaptured", { cmd: f.command, code: f.code, shell: f.shell });
  await explainCommand([f.command, "", note], { ai: opts.ai, shell: f.shell }, ctx);
}

export async function fixCommand(opts: FixOptions, ctx: Ctx): Promise<void> {
  const failed = readLastFailed();
  if (!failed) {
    const shell = hookShellFor(detectShell().kind);
    const installed = shell ? await isHookInstalled(shell) : false;
    blank();
    print(status.info(t(installed ? "fix.noneInstalled" : "fix.none")));
    if (!installed) print(status.hint(t("fix.noneHint", { cmd: cmd("pikaclow init") })));
    blank();
    return;
  }

  const home = os.homedir();
  blank();
  print(...titleBlock("FIX", t("fix.last")));
  blank();
  const risk = assessCommand(failed.command);
  const lines = failed.command.split("\n").map((l, i) => (i === 0 ? c.brand(sym("pointer")) + " " : "  ") + c.bold(l));
  lines.push(c.muted(t("fix.meta", { code: failed.code, when: ago(failed.at), dir: tildify(failed.cwd, home) })));
  const tone = risk.level === "danger" ? P.err : risk.level === "caution" ? P.warn : undefined;
  print(...box(lines, { width: Math.min(columns() - 2, 96), color: tone, titleColor: tone, title: failed.shell }).map((l) => " " + l));
  blank();

  // Re-running is the only way to read the real error, but never for risky commands by default.
  let rerun: boolean;
  if (risk.level !== "safe") print(status.warn(t("fix.dangerous")));
  if (opts.yes || !isInteractive()) {
    rerun = risk.level === "safe";
  } else {
    const choice = await select({
      message: t("fix.question"),
      options: [
        { value: "rerun", label: t("fix.rerun"), hint: t("fix.rerunHint") },
        { value: "explain", label: t("fix.explainOnly"), hint: t("fix.explainOnlyHint") },
      ],
      initial: risk.level === "safe" ? 0 : 1,
      signal: ctx.signal,
    });
    if (isCancel(choice)) return;
    rerun = choice === "rerun";
    if (rerun && risk.level === "danger") {
      const sure = await input({
        message: t("sh.confirmDanger"),
        placeholder: "yes",
        validate: (v) => (v.trim().toLowerCase() === "yes" ? undefined : t("sh.mustTypeYes")),
        signal: ctx.signal,
      });
      if (isCancel(sure)) return;
    }
  }

  if (!rerun) return explainOnly(failed, opts, ctx);

  const cwd = existsSync(failed.cwd) ? failed.cwd : process.cwd();
  if (cwd !== failed.cwd) print(status.warn(t("fix.missingDir", { dir: tildify(failed.cwd, home) })));
  const before = process.cwd();
  process.chdir(cwd);
  try {
    const ok = await explain([], { ai: opts.ai, shell: failed.shell }, ctx, [failed.command]);
    if (ok) clearLastFailed();
  } finally {
    process.chdir(before);
  }
}
