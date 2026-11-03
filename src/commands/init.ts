import os from "node:os";
import type { Ctx } from "../core/context.js";
import { isWindows } from "../core/exec.js";
import { tildify } from "../core/format.js";
import { FIX_KEY, hookScript, hookShellFor, installHook, profilePath, uninstallHook, type HookShell } from "../core/hook.js";
import { detectShell } from "../core/shell.js";
import { pwsh } from "../core/win/pwsh.js";
import { t } from "../i18n/index.js";
import { box, cmd, status, titleBlock } from "../ui/components.js";
import { blank, print } from "../ui/print.js";
import { confirm, isCancel } from "../ui/prompts.js";
import { columns, isInteractive, write } from "../ui/terminal.js";
import { c, sym } from "../ui/theme.js";

export interface InitOptions {
  print?: boolean;
  uninstall?: boolean;
  yes?: boolean;
}

const LABEL: Record<HookShell, string> = { powershell: "Windows PowerShell", pwsh: "PowerShell 7", bash: "bash", zsh: "zsh", fish: "fish" };

/** How to load the hook in the current shell without opening a new one. */
function reloadCommand(shell: HookShell): string {
  return shell === "powershell" || shell === "pwsh" ? ". $PROFILE" : shell === "zsh" ? "source ~/.zshrc" : shell === "fish" ? "source ~/.config/fish/config.fish" : "source ~/.bashrc";
}

export const hookHint = () => t("init.hint", { key: FIX_KEY });

export async function initCommand(shellArg: string | undefined, opts: InitOptions, ctx: Ctx): Promise<void> {
  const info = detectShell(shellArg);
  const shell = hookShellFor(info.kind);
  if (!shell) {
    print(status.warn(t("init.unsupported", { shell: info.label })));
    process.exitCode = 1;
    return;
  }
  if (opts.print) {
    write(hookScript(shell, hookHint()));
    return;
  }

  const home = os.homedir();
  if (opts.uninstall) {
    const r = await uninstallHook(shell);
    print(r.removed ? status.ok(t("init.removed", { file: tildify(r.profile, home) })) : status.info(t("init.notInstalled", { file: tildify(r.profile, home) })));
    return;
  }

  blank();
  print(...titleBlock("INIT", LABEL[shell]));
  blank();
  const w = Math.min(columns() - 2, 90);
  print(
    ...box(
      [
        c.brand(sym("bullet")) + " " + t("init.what1"),
        c.brand(sym("bullet")) + " " + t("init.what2", { key: c.keycap(FIX_KEY), cmd: cmd("pikaclow fix") }),
        c.brand(sym("bullet")) + " " + c.muted(t("init.what3")),
      ],
      { title: sym("bolt") + " " + t("cli.init", { key: FIX_KEY }), width: w },
    ).map((l) => " " + l),
  );
  blank();

  if (!opts.yes) {
    if (!isInteractive()) {
      print(status.hint(t("init.manual", { cmd: cmd("pikaclow init") })));
      return;
    }
    const ok = await confirm({ message: t("init.confirm", { file: tildify(await profilePath(shell), home) }), initial: true, signal: ctx.signal });
    if (isCancel(ok) || !ok) {
      print(c.faint("  " + t("common.cancelled")));
      return;
    }
  }

  const r = await installHook(shell, hookHint());
  blank();
  print(status.ok(t(r.updated ? "init.updated" : "init.done", { shell: LABEL[shell] })) + c.faint("  " + tildify(r.profile, home)));
  print(status.hint(t("init.activate", { cmd: cmd(reloadCommand(shell)) })));
  print(status.hint(t("init.try", { example: cmd("npm run nope"), key: c.keycap(FIX_KEY) })));

  // A Restricted policy would silently skip the profile, so say it now rather than never.
  if (isWindows && (shell === "powershell" || shell === "pwsh")) {
    const pol = (await pwsh.run("[Console]::Out.Write((Get-ExecutionPolicy).ToString())").catch(() => "")).trim();
    if (/^(Restricted|AllSigned)$/i.test(pol)) {
      print(status.warn(t("init.policy", { pol, fix: cmd("Set-ExecutionPolicy -Scope CurrentUser RemoteSigned") })));
    }
  }
  blank();
}
