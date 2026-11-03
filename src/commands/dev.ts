import os from "node:os";
import { join } from "node:path";
import { onInterrupt, type Ctx } from "../core/context.js";
import { which } from "../core/exec.js";
import { tildify } from "../core/format.js";
import { canBind, findFreePort, killProcess, listPorts, type PortEntry } from "../core/ports.js";
import { detectFramework, findProject, installCommand, pickScript, runArgs, type Framework, type Project } from "../core/project.js";
import { detectShell, runInShell } from "../core/shell.js";
import { t } from "../i18n/index.js";
import { box, cmd, status, titleBlock } from "../ui/components.js";
import { withKeyboardReleased } from "../ui/keys.js";
import { blank, print } from "../ui/print.js";
import { confirm, isCancel, select } from "../ui/prompts.js";
import { columns, isInteractive } from "../ui/terminal.js";
import { c, P, sym } from "../ui/theme.js";
import { explain } from "./explain.js";

export interface DevOptions {
  port?: string;
  yes?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (s: string) => (/^[\w.:@/=-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** Runs a command line in the user's shell with the terminal handed over to it. */
async function runAttached(line: string, cwd: string, env: Record<string, string> = {}): Promise<{ code: number | null; interrupted: boolean }> {
  print(c.faint(`${sym("pointer")} ${line}`));
  blank();
  let interrupted = false;
  // Ctrl+C belongs to the dev server; we only note that it happened.
  const off = onInterrupt(() => {
    interrupted = true;
  });
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const code = await withKeyboardReleased(() => runInShell(line, detectShell(), cwd));
    return { code, interrupted };
  } finally {
    off();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function waitUntilFree(port: number, ms = 4000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await canBind(port)) return true;
  return false;
}

type PortPlan = { port: number | null; extra: string[]; env: Record<string, string> } | null;

/** Makes sure the dev server's port is usable. Null means: stop, the user cancelled. */
async function planPort(project: Project, fw: Framework | null, opts: DevOptions, ctx: Ctx): Promise<PortPlan> {
  const forced = opts.port ? Number(opts.port) : null;
  const moveTo = (port: number) => ({ port, extra: fw?.portFlag ? [fw.portFlag, String(port)] : [], env: { PORT: String(port) } });
  if (forced) return moveTo(forced);
  if (!fw) return { port: null, extra: [], env: {} };
  const port = fw.port;
  if (await canBind(port)) return { port, extra: [], env: {} };

  const all = await listPorts().catch(() => [] as PortEntry[]);
  const holders = all.filter((e) => e.port === port);
  const home = os.homedir();
  const lines = holders.length
    ? holders.map(
        (h) =>
          c.brand(sym("pointer")) + " " + c.bold(h.process) + c.faint(` (PID ${h.pid})`) + (h.app ? c.muted(" · " + h.app) : "") +
          (h.project ? c.muted(" · " + (h.project === project.root ? t("dev.sameProject") : tildify(h.project, home))) : ""),
      )
    : [c.muted(t("dev.portHidden"))];
  print(...box(lines, { title: sym("bolt") + " " + t("dev.portBusy", { port }), width: Math.min(columns() - 2, 96), color: P.warn, titleColor: P.warn }).map((l) => " " + l));
  blank();

  const free = fw.portFlag || !fw.fixedPort ? await findFreePort(port + 1, new Set(all.map((e) => e.port))) : null;
  const killable = holders.filter((h) => !h.system);
  if (opts.yes || !isInteractive()) {
    return free && fw.portFlag ? moveTo(free) : { port, extra: [], env: {} };
  }
  const options: { value: string; label: string; hint?: string }[] = [];
  if (killable.length) options.push({ value: "kill", label: t("dev.kill"), hint: killable.map((h) => `${h.process} ${h.pid}`).join(", ") });
  if (free && (fw.portFlag || !fw.fixedPort)) options.push({ value: "move", label: t("dev.otherPort", { port: free }), hint: fw.portFlag ? `${fw.portFlag} ${free}` : `PORT=${free}` });
  options.push({ value: "anyway", label: t("dev.anyway") });
  const choice = await select({ message: t("dev.what", { port }), options, signal: ctx.signal });
  if (isCancel(choice)) return null;
  if (choice === "move" && free) return moveTo(free);
  if (choice === "kill") {
    for (const h of killable) {
      const r = await killProcess(h.pid);
      print(" " + (r === "killed" || r === "gone" ? status.ok(t("ports.killed", { name: h.process, pid: h.pid, port })) : status.fail(t("ports.denied", { name: h.process, pid: h.pid }))));
    }
    await waitUntilFree(port);
    blank();
  }
  return { port, extra: [], env: {} };
}

export async function devCommand(scriptArg: string | undefined, opts: DevOptions, ctx: Ctx): Promise<void> {
  const project = findProject(process.cwd());
  if (!project) {
    print(status.warn(t("dev.noProject")));
    print(status.hint(t("dev.noProjectHint", { cmd: cmd("npm create vite@latest") })));
    process.exitCode = 1;
    return;
  }
  const names = Object.keys(project.scripts);
  if (!names.length) {
    print(status.warn(t("dev.noScripts")) + c.faint("  " + join(tildify(project.root, os.homedir()), "package.json")));
    process.exitCode = 1;
    return;
  }
  let script = pickScript(project.scripts, scriptArg);
  if (scriptArg && !script) {
    print(status.fail(t("dev.noScript", { name: scriptArg, list: names.join(", ") })));
    process.exitCode = 1;
    return;
  }
  if (!script) {
    if (!isInteractive()) {
      print(status.fail(t("dev.noScript", { name: "dev", list: names.join(", ") })));
      process.exitCode = 1;
      return;
    }
    const picked = await select({ message: t("dev.pickScript"), options: names.map((n) => ({ value: n, label: n, hint: project.scripts[n] })), signal: ctx.signal });
    if (isCancel(picked)) return;
    script = picked;
  }

  const fw = detectFramework(project.scripts[script] ?? "", project.deps);
  blank();
  const subtitle = `${project.name} · ${project.pm} run ${script}`;
  print(...titleBlock("DEV", subtitle));
  blank();
  print(
    "  " +
      [
        c.chip(project.pm) + c.faint(project.pmReason === "default" ? "" : " " + project.pmReason),
        fw?.name ? c.chip(fw.name) : "",
        fw ? c.muted("port ") + c.brand(String(opts.port ?? fw.port)) : c.faint(t("dev.portUnknown")),
        c.faint(tildify(project.root, os.homedir())),
      ]
        .filter(Boolean)
        .join("  "),
  );
  blank();

  if (!which(project.pm)) {
    print(status.fail(t("dev.pmMissing", { pm: project.pm, reason: project.pmReason })));
    print(status.hint(t("dev.pmFix", { cmd: cmd(project.pm === "bun" ? "npm install -g bun" : "corepack enable") })));
    process.exitCode = 1;
    return;
  }

  if (!project.hasNodeModules) {
    const install = installCommand(project.pm);
    const go = opts.yes || !isInteractive() ? true : await confirm({ message: t("dev.install", { cmd: install }), initial: true, signal: ctx.signal });
    if (isCancel(go)) return;
    if (go) {
      const r = await runAttached(install, project.root);
      blank();
      if (r.code !== 0) {
        print(status.fail(t("dev.installFailed", { code: String(r.code ?? "?") })));
        process.exitCode = 1;
        return;
      }
    }
  }

  const plan = await planPort(project, fw, opts, ctx);
  if (!plan) return;
  const line = [project.pm, ...runArgs(project.pm, script, plan.extra)].map(quote).join(" ");
  const r = await runAttached(line, project.root, plan.env);
  blank();
  if (r.interrupted || r.code === 0 || r.code === 130) {
    print(status.ok(t("dev.stopped")));
    blank();
    return;
  }
  print(status.fail(t("dev.failed", { cmd: line, code: String(r.code ?? "?") })));
  process.exitCode = r.code ?? 1;
  if (!isInteractive()) return;
  const why = await confirm({ message: t("dev.explain"), initial: true, signal: ctx.signal });
  if (isCancel(why) || !why) return;
  const before = process.cwd();
  process.chdir(project.root);
  try {
    await explain([], {}, ctx, [line]);
  } finally {
    process.chdir(before);
  }
}
