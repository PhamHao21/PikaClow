import { existsSync } from "node:fs";
import os from "node:os";
import { delimiter, join } from "node:path";
import { createProvider } from "../core/ai/index.js";
import type { Ctx } from "../core/context.js";
import { capture, isWindows, which } from "../core/exec.js";
import { formatBytes } from "../core/format.js";
import { listPorts } from "../core/ports.js";
import { disks } from "../core/system/sources.js";
import { osName } from "../core/system/info.js";
import { pwsh } from "../core/win/pwsh.js";
import { t } from "../i18n/index.js";
import { cmd, titleBlock } from "../ui/components.js";
import { LiveRegion } from "../ui/live.js";
import { blank, print, printJson } from "../ui/print.js";
import { isTTY } from "../ui/terminal.js";
import { c, P, sym } from "../ui/theme.js";
import { spinnerFrames } from "../ui/spinner.js";
import { fit } from "../ui/text.js";

type Level = "ok" | "warn" | "fail" | "info";

interface Result {
  level: Level;
  detail: string;
  fix?: string;
}

interface Check {
  id: string;
  label: string;
  group: string;
  run: () => Promise<Result | null>;
}

const version = (s: string | null) => (s ? (/\d+\.\d+(\.\d+)?/.exec(s)?.[0] ?? s.split("\n")[0]!) : null);

async function toolVersion(bin: string, args = ["--version"]): Promise<string | null> {
  if (!which(bin)) return null;
  return version(await capture(bin, args, { timeout: 12000 }));
}

function checks(): Check[] {
  const list: Check[] = [
    {
      id: "node",
      group: "runtime",
      label: "Node.js",
      run: async () => {
        const major = Number(process.versions.node.split(".")[0]);
        if (major < 20) return { level: "fail", detail: t("doctor.nodeOld", { v: process.version }), fix: "https://nodejs.org" };
        if (major % 2 === 1) return { level: "warn", detail: t("doctor.nodeOdd", { v: process.version }) };
        return { level: "ok", detail: process.version };
      },
    },
    {
      id: "npm",
      group: "runtime",
      label: "npm",
      run: async () => {
        const v = await toolVersion("npm");
        return v ? { level: "ok", detail: v } : { level: "fail", detail: t("doctor.missing"), fix: "https://nodejs.org" };
      },
    },
    {
      id: "pms",
      group: "runtime",
      label: t("doctor.otherPms"),
      run: async () => {
        const found = (await Promise.all(["pnpm", "yarn", "bun", "deno"].map(async (p) => [p, await toolVersion(p)] as const))).filter(([, v]) => v);
        return { level: "info", detail: found.length ? found.map(([p, v]) => `${p} ${v}`).join(", ") : t("doctor.none") };
      },
    },
    {
      id: "npmPath",
      group: "runtime",
      label: t("doctor.npmGlobal"),
      run: async () => {
        if (!which("npm")) return null;
        const prefix = await capture("npm", ["config", "get", "prefix"], { timeout: 12000 });
        if (!prefix) return null;
        const bin = isWindows ? prefix : join(prefix, "bin");
        const inPath = (process.env.PATH ?? "").split(delimiter).some((p) => p.replace(/[\\/]+$/, "").toLowerCase() === bin.replace(/[\\/]+$/, "").toLowerCase());
        return inPath ? { level: "ok", detail: bin } : { level: "warn", detail: t("doctor.npmGlobalMissing", { dir: bin }), fix: t("doctor.addToPath", { dir: bin }) };
      },
    },
    {
      id: "git",
      group: "tools",
      label: "Git",
      run: async () => {
        const v = await toolVersion("git");
        if (!v) return { level: "fail", detail: t("doctor.missing"), fix: isWindows ? "winget install Git.Git" : "https://git-scm.com/downloads" };
        const [name, email] = await Promise.all([capture("git", ["config", "--global", "user.name"]), capture("git", ["config", "--global", "user.email"])]);
        if (!name || !email) return { level: "warn", detail: t("doctor.gitNoIdentity", { v }), fix: 'git config --global user.name "Your Name"; git config --global user.email you@example.com' };
        return { level: "ok", detail: `${v} · ${name}` };
      },
    },
    {
      id: "python",
      group: "tools",
      label: "Python",
      run: async () => {
        const bin = isWindows ? "python" : which("python3") ? "python3" : "python";
        const path = which(bin);
        if (!path) return { level: "info", detail: t("doctor.notInstalled") };
        if (isWindows && /WindowsApps/i.test(path)) {
          const v = await capture(bin, ["--version"], { timeout: 8000 });
          if (!v) return { level: "warn", detail: t("doctor.pythonAlias"), fix: "winget install Python.Python.3.12" };
        }
        const v = await toolVersion(bin);
        return v ? { level: "ok", detail: v } : { level: "warn", detail: t("doctor.pythonAlias") };
      },
    },
    {
      id: "docker",
      group: "tools",
      label: "Docker",
      run: async () => {
        const v = await toolVersion("docker");
        return { level: "info", detail: v ?? t("doctor.notInstalled") };
      },
    },
    {
      id: "path",
      group: "system",
      label: "PATH",
      run: async () => {
        const parts = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
        const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
        const seen = new Map<string, string>();
        let dups = 0;
        for (const p of parts) {
          const n = norm(p);
          if (seen.has(n)) dups++;
          else seen.set(n, p);
        }
        const missing = [...seen.values()].filter((p) => !existsSync(p.replace(/%[^%]+%/g, "")));
        const detail = t("doctor.pathSummary", { n: parts.length, dups, missing: missing.length });
        if (dups || missing.length) return { level: "warn", detail, fix: missing.length ? t("doctor.pathMissingExample", { dir: missing[0]! }) : undefined };
        return { level: "ok", detail };
      },
    },
    {
      id: "disk",
      group: "system",
      label: t("doctor.disk"),
      run: async () => {
        const list = await disks();
        const sys = list.find((d) => (isWindows ? /^C:/i.test(d.mount) : d.mount === "/" || d.mount === "/System/Volumes/Data")) ?? list[0];
        if (!sys) return null;
        const pctFree = (sys.free / sys.total) * 100;
        const detail = t("doctor.diskFree", { mount: sys.mount, free: formatBytes(sys.free), pct: pctFree.toFixed(0) });
        if (pctFree < 5 || sys.free < 5 * 1024 ** 3) return { level: "fail", detail, fix: "pikaclow clean ~ · pikaclow clean --caches" };
        if (pctFree < 12 || sys.free < 15 * 1024 ** 3) return { level: "warn", detail, fix: "pikaclow clean ~" };
        return { level: "ok", detail };
      },
    },
    {
      id: "memory",
      group: "system",
      label: "RAM",
      run: async () => {
        const free = os.freemem();
        const total = os.totalmem();
        const detail = t("doctor.ramFree", { free: formatBytes(free), total: formatBytes(total) });
        return free / total < 0.1 ? { level: "warn", detail, fix: "pikaclow top" } : { level: "ok", detail };
      },
    },
    {
      id: "ports",
      group: "system",
      label: t("doctor.devPorts"),
      run: async () => {
        const busy = (await listPorts()).filter((e) => [3000, 3001, 4200, 5000, 5173, 8000, 8080].includes(e.port) && !e.system);
        if (!busy.length) return { level: "ok", detail: t("doctor.devPortsFree") };
        return { level: "info", detail: busy.map((e) => `:${e.port} ${e.process}`).join(", "), fix: `pikaclow ports ${busy[0]!.port}` };
      },
    },
    {
      id: "ai",
      group: "ai",
      label: t("doctor.ai"),
      run: async () => {
        const p = createProvider();
        const st = await p.status();
        if (!st.ok) return { level: "info", detail: t("doctor.aiOff", { name: p.label }), fix: "pikaclow setup" };
        if (p.kind === "ollama") {
          const models = await p.models().catch(() => []);
          if (!models.length) return { level: "warn", detail: t("doctor.aiNoModels", { v: st.version ?? "" }), fix: "pikaclow models" };
          return { level: "ok", detail: t("doctor.aiOllama", { v: st.version ?? "", n: models.length, model: p.model ?? models[0]!.name }) };
        }
        return { level: "ok", detail: `${p.label} · ${p.model ?? "?"}` };
      },
    },
  ];
  if (isWindows) {
    list.push(
      {
        id: "execPolicy",
        group: "system",
        label: "PowerShell policy",
        run: async () => {
          const pol = (await pwsh.run("[Console]::Out.Write((Get-ExecutionPolicy).ToString())").catch(() => "")).trim();
          if (!pol) return null;
          if (/^(Restricted|AllSigned)$/i.test(pol)) return { level: "fail", detail: t("doctor.execPolicyBad", { pol }), fix: "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned" };
          return { level: "ok", detail: pol };
        },
      },
      {
        id: "longPaths",
        group: "system",
        label: "Long paths",
        run: async () => {
          const v = (await pwsh.run("[Console]::Out.Write((Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled).LongPathsEnabled)").catch(() => "")).trim();
          if (v === "1") return { level: "ok", detail: t("doctor.enabled") };
          return { level: "warn", detail: t("doctor.longPathsOff"), fix: t("doctor.longPathsFix") };
        },
      },
    );
  }
  return list;
}

const ICON: Record<Level, () => string> = {
  ok: () => c.tile(sym("ok"), P.ok),
  warn: () => c.tile(sym("warn"), P.warn),
  fail: () => c.tile(sym("fail"), P.err),
  info: () => c.tile(sym("info"), P.info),
};

export async function doctorCommand(opts: { json?: boolean }, _ctx: Ctx): Promise<void> {
  const list = checks();
  const results = new Map<string, Result | null | "pending">(list.map((ch) => [ch.id, "pending"]));
  const labelW = Math.max(...list.map((ch) => ch.label.length)) + 2;
  const live = isTTY() && !opts.json;
  const region = live ? new LiveRegion(() => draw()) : null;
  let frame = 0;
  const frames = spinnerFrames();
  const line = (ch: Check) => {
    const r = results.get(ch.id);
    if (r === "pending") return "  " + c.brand(frames[frame % frames.length]!) + " " + fit(ch.label, labelW) + c.faint(t("doctor.checking"));
    if (!r) return "";
    return "  " + ICON[r.level]() + " " + fit(ch.label, labelW) + (r.level === "fail" ? c.err(r.detail) : r.level === "warn" ? c.warn(r.detail) : c.muted(r.detail));
  };
  const draw = () => region?.render(list.map(line).filter(Boolean));

  if (!opts.json) {
    blank();
    print(...titleBlock("DOCTOR", osName()));
    blank();
  }
  const timer = live ? setInterval(() => (frame++, draw()), 110) : null;
  draw();
  await Promise.all(
    list.map(async (ch) => {
      try {
        results.set(ch.id, await ch.run());
      } catch (e) {
        results.set(ch.id, { level: "warn", detail: (e as Error).message });
      }
      draw();
    }),
  );
  if (timer) clearInterval(timer);

  const final = list.map((ch) => ({ ch, r: results.get(ch.id) as Result | null })).filter((x) => x.r);
  if (opts.json) return printJson(final.map(({ ch, r }) => ({ id: ch.id, label: ch.label, ...r })));
  if (region) {
    draw();
    region.done();
  } else print(...list.map(line).filter(Boolean));

  const problems = final.filter(({ r }) => r!.level === "fail" || r!.level === "warn");
  blank();
  if (!problems.length) {
    print(" " + c.ok(sym("ok") + " " + t("doctor.allGood")));
  } else {
    print(" " + c.bold(t("doctor.fixes")));
    for (const { ch, r } of problems) {
      if (!r!.fix) continue;
      print("  " + ICON[r!.level]() + " " + c.bold(ch.label) + c.faint(": ") + cmd(r!.fix));
    }
  }
  blank();
  if (final.some(({ r }) => r!.level === "fail")) process.exitCode = 1;
}
