import { existsSync, statSync } from "node:fs";
import os from "node:os";
import { join, parse, relative, resolve } from "node:path";
import { findJunk, folderSize, gitIgnored, lastTouched, removeFolder, type JunkItem } from "../core/clean/scanner.js";
import { capture, run, which } from "../core/exec.js";
import { formatAge, formatBytes, tildify } from "../core/format.js";
import type { Ctx } from "../core/context.js";
import { t } from "../i18n/index.js";
import { box, titleBlock, status, table, cmd } from "../ui/components.js";
import { blank, print, printJson } from "../ui/print.js";
import { confirm, isCancel, multiselect } from "../ui/prompts.js";
import { spinner } from "../ui/spinner.js";
import { columns, isInteractive } from "../ui/terminal.js";
import { c } from "../ui/theme.js";
import { fit, truncateStart, width } from "../ui/text.js";

export interface CleanOptions {
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  depth?: string;
  caches?: boolean;
}

const DAY = 86400_000;
const STALE_DAYS = 30;

const ageUnits = () => ({
  day: t("time.day"), days: t("time.days"), month: t("time.month"), months: t("time.months"),
  year: t("time.year"), years: t("time.years"), today: t("time.today"),
});

function kindLabel(item: JunkItem): string {
  return t(`clean.kind.${item.rule.kind}` as "clean.kind.deps");
}

/** Pre-select regenerable items that are safe and not part of active work. */
function preselect(item: JunkItem, now: number): boolean {
  const verified = item.rule.risk === "safe" || item.gitIgnored === true;
  if (!verified) return false;
  if (item.rule.kind === "cache") return true;
  return item.lastTouched > 0 && now - item.lastTouched > STALE_DAYS * DAY;
}

export async function cleanCommand(pathArg: string | undefined, opts: CleanOptions, ctx: Ctx): Promise<void> {
  if (opts.caches) return cleanCaches(opts, ctx);
  const root = resolve(pathArg ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(t("clean.notFolder", { path: root }));
  const home = os.homedir();
  const quiet = Boolean(opts.json);

  if (!quiet) {
    blank();
    print(...titleBlock("CLEAN", tildify(root, home)));
    if (parse(root).root === root) print(" " + c.warn(t("clean.driveRootNote")));
    blank();
  }

  // 1. Find candidates.
  const spin = quiet ? null : spinner(t("clean.scanning"));
  let found: Awaited<ReturnType<typeof findJunk>>;
  try {
    found = await findJunk(root, {
      maxDepth: Number(opts.depth) || 8,
      signal: ctx.signal,
      onProgress: (p) =>
        spin?.update(
          t("clean.scanProgress", { dirs: p.dirs.toLocaleString(), found: p.found }) + "  " + c.faint(truncateStart(tildify(p.current, home), Math.max(10, columns() - 50))),
        ),
    });
  } catch (e) {
    spin?.stop();
    throw e;
  }
  if (found.length === 0) {
    spin?.stop();
    if (quiet) return printJson([]);
    print(" " + status.ok(t("clean.nothing")));
    blank();
    return;
  }

  // 2. Measure sizes, ages and git status.
  const items: JunkItem[] = [];
  const ignoredByProject = new Map<string, Map<string, boolean> | null>();
  let total = 0;
  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    const label = () => t("clean.measuring", { i: i + 1, n: found.length, size: formatBytes(total) }) + "  " + c.faint(truncateStart(tildify(f.path, home), Math.max(10, columns() - 50)));
    spin?.update(label());
    let lastDraw = 0;
    const size = await folderSize(f.path, {
      signal: ctx.signal,
      onBytes: (d) => {
        total += d;
        const now = Date.now();
        if (now - lastDraw > 120) {
          lastDraw = now;
          spin?.update(label());
        }
      },
    });
    let gitFlag: boolean | null = null;
    if (f.rule.risk === "verify") {
      if (!ignoredByProject.has(f.project)) {
        const names = found.filter((x) => x.project === f.project && x.rule.risk === "verify").map((x) => x.name);
        ignoredByProject.set(f.project, await gitIgnored(f.project, names));
      }
      gitFlag = ignoredByProject.get(f.project)?.get(f.name) ?? null;
    }
    items.push({ ...f, size: size.bytes, files: size.files, partial: size.partial, lastTouched: await lastTouched(f.project), gitIgnored: gitFlag });
  }
  spin?.stop();
  items.sort((a, b) => b.size - a.size);
  const now = Date.now();

  if (quiet) {
    return printJson(
      items.map((i) => ({
        path: i.path,
        project: i.project,
        kind: i.rule.kind,
        ecosystem: i.rule.ecosystem,
        bytes: i.size,
        files: i.files,
        lastTouched: i.lastTouched ? new Date(i.lastTouched).toISOString() : null,
        gitIgnored: i.gitIgnored,
        suggested: preselect(i, now),
        regenerate: i.rule.regen,
      })),
    );
  }

  const rel = (p: string) => relative(root, p) || ".";
  const age = (i: JunkItem) => (i.lastTouched ? formatAge(now - i.lastTouched, ageUnits()) : "?");
  const sum = (list: JunkItem[]) => list.reduce((a, b) => a + b.size, 0);

  const describe = (i: JunkItem) => {
    const touched = i.lastTouched && now - i.lastTouched < DAY ? t("clean.touchedToday") : t("clean.touched", { age: age(i) });
    const tags: string[] = [kindLabel(i), i.rule.ecosystem, touched];
    if (i.rule.risk === "verify" && i.gitIgnored !== true) tags.push(c.warn(t("clean.unverified")));
    return tags.join(" · ");
  };

  // 3. Non-interactive: report only.
  if (opts.dryRun || !isInteractive()) {
    const w = columns() - 2;
    const rows = items.map((i) => [
      (preselect(i, now) ? c.brand("●") : c.faint("○")) + " " + rel(i.path),
      c.bold(formatBytes(i.size)) + (i.partial ? "+" : ""),
      age(i),
      c.muted(kindLabel(i) + " · " + i.rule.ecosystem) + (i.rule.risk === "verify" && i.gitIgnored !== true ? " " + c.warn("!") : ""),
    ]);
    print(
      ...table(
        [
          { header: t("clean.colFolder"), grow: true, min: 16 },
          { header: t("clean.colSize"), align: "right" },
          { header: t("clean.colTouched") },
          { header: t("clean.colKind"), grow: true, min: 8 },
        ],
        rows,
        w,
      ).map((l) => " " + l),
    );
    blank();
    const suggested = items.filter((i) => preselect(i, now));
    print(" " + t("clean.summary", { count: items.length, size: c.brandBold(formatBytes(sum(items))), suggested: suggested.length, suggestedSize: formatBytes(sum(suggested)) }));
    if (opts.yes && !opts.dryRun) {
      await deleteItems(suggested, root);
      return;
    }
    print(" " + c.faint(t("clean.dryRunNote", { cmd: cmd("pikaclow clean") })));
    blank();
    return;
  }

  // 4. Let the user choose.
  const longest = Math.max(...items.map((i) => width(rel(i.path))));
  const pathW = Math.max(12, Math.min(longest, 56, columns() - 50));
  const chosen = await multiselect({
    message: t("clean.pick", { count: items.length, size: formatBytes(sum(items)) }),
    options: items.map((i) => ({
      value: i,
      label: fit(truncateStart(rel(i.path), pathW), pathW) + "  " + c.bold(fit(formatBytes(i.size) + (i.partial ? "+" : ""), 9, "right")),
      hint: describe(i),
      selected: preselect(i, now),
    })),
    status: (sel) => c.muted(t("clean.selected", { count: sel.length, size: c.brandBold(formatBytes(sum(sel))) })),
    required: true,
    signal: ctx.signal,
  });
  if (isCancel(chosen)) {
    print(" " + status.hint(t("clean.noneDeleted")));
    blank();
    return;
  }
  const ok = await confirm({
    message: t("clean.confirm", { count: chosen.length, size: formatBytes(sum(chosen)) }),
    signal: ctx.signal,
  });
  if (isCancel(ok) || !ok) {
    print(" " + status.hint(t("clean.noneDeleted")));
    blank();
    return;
  }
  await deleteItems(chosen, root);
}

async function deleteItems(items: JunkItem[], root: string): Promise<void> {
  const spin = spinner(t("clean.deleting", { i: 0, n: items.length }));
  let freed = 0;
  const failed: { item: JunkItem; reason: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    spin.update(t("clean.deleting", { i: i + 1, n: items.length }) + "  " + c.faint(relative(root, item.path)));
    try {
      await removeFolder(item.path);
      freed += item.size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      failed.push({ item, reason: /EBUSY|EPERM|EACCES/.test(code) ? t("clean.inUse") : (e as Error).message });
    }
  }
  spin.stop();
  blank();
  const lines = [status.ok(t("clean.freed", { size: c.brandBold(formatBytes(freed)), count: items.length - failed.length }))];
  for (const f of failed.slice(0, 5)) lines.push(status.warn(fit(relative(root, f.item.path), 40) + " " + c.muted(f.reason)));
  const regen = [...new Set(items.filter((i) => !failed.some((f) => f.item === i)).map((i) => i.rule.regen))].filter((r) => !r.startsWith("("));
  if (regen.length) lines.push(c.faint(t("clean.regenHint", { cmds: regen.join(", ") })));
  print(...box(lines, { title: t("clean.done"), width: Math.min(columns() - 2, Math.max(50, ...lines.map((l) => width(l) + 4))) }).map((l) => " " + l));
  blank();
}

// ── Package-manager caches ─────────────────────────────────────────────────────
interface CacheTarget {
  id: string;
  label: string;
  path: string;
  cleanCmd: [string, string[]];
  size: number;
}

async function detectCaches(): Promise<Omit<CacheTarget, "size">[]> {
  const out: Omit<CacheTarget, "size">[] = [];
  const probes: Promise<void>[] = [];
  const add = (id: string, label: string, getPath: () => Promise<string | null>, cleanCmd: [string, string[]]) => {
    if (!which(cleanCmd[0])) return;
    probes.push(
      getPath().then((p) => {
        if (p && existsSync(p)) out.push({ id, label, path: p, cleanCmd });
      }),
    );
  };
  add("npm", "npm cache", () => capture("npm", ["config", "get", "cache"], { timeout: 15000 }), ["npm", ["cache", "clean", "--force"]]);
  add("pnpm", "pnpm store", () => capture("pnpm", ["store", "path"], { timeout: 15000 }), ["pnpm", ["store", "prune"]]);
  add("yarn", "Yarn cache", () => capture("yarn", ["cache", "dir"], { timeout: 15000 }), ["yarn", ["cache", "clean"]]);
  add("pip", "pip cache", () => capture("pip", ["cache", "dir"], { timeout: 15000 }), ["pip", ["cache", "purge"]]);
  add("bun", "Bun cache", async () => join(os.homedir(), ".bun", "install", "cache"), ["bun", ["pm", "cache", "rm"]]);
  add("go", "Go build cache", () => capture("go", ["env", "GOCACHE"], { timeout: 15000 }), ["go", ["clean", "-cache"]]);
  await Promise.all(probes);
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

async function cleanCaches(opts: CleanOptions, ctx: Ctx): Promise<void> {
  if (!opts.json) {
    blank();
    print(...titleBlock("CACHES", t("clean.cachesSubtitle")));
    blank();
  }
  const spin = opts.json ? null : spinner(t("clean.cachesDetecting"));
  const found = await detectCaches();
  const targets: CacheTarget[] = [];
  for (const f of found) {
    spin?.update(t("clean.cachesMeasuring", { name: f.label }));
    const s = await folderSize(f.path, { signal: ctx.signal });
    targets.push({ ...f, size: s.bytes });
  }
  spin?.stop();
  if (opts.json) return printJson(targets.map((x) => ({ id: x.id, path: x.path, bytes: x.size, command: [x.cleanCmd[0], ...x.cleanCmd[1]].join(" ") })));
  if (targets.length === 0) {
    print(" " + status.ok(t("clean.cachesNone")));
    blank();
    return;
  }
  const sum = (l: CacheTarget[]) => l.reduce((a, b) => a + b.size, 0);
  if (opts.dryRun || !isInteractive()) {
    for (const x of targets) print(" " + fit(x.label, 16) + fit(formatBytes(x.size), 10, "right") + "  " + c.faint(tildify(x.path, os.homedir())) + "  " + cmd([x.cleanCmd[0], ...x.cleanCmd[1]].join(" ")));
    blank();
    return;
  }
  const chosen = await multiselect({
    message: t("clean.cachesPick"),
    options: targets.map((x) => ({
      value: x,
      label: fit(x.label, 16) + c.bold(fit(formatBytes(x.size), 10, "right")),
      hint: [x.cleanCmd[0], ...x.cleanCmd[1]].join(" "),
      selected: x.size > 200 * 1024 * 1024,
    })),
    status: (sel) => c.muted(t("clean.selected", { count: sel.length, size: c.brandBold(formatBytes(sum(sel))) })),
    required: true,
    signal: ctx.signal,
  });
  if (isCancel(chosen)) return;
  let freed = 0;
  for (const x of chosen) {
    const s = spinner(t("clean.cachesRunning", { cmd: [x.cleanCmd[0], ...x.cleanCmd[1]].join(" ") }));
    const r = await run(x.cleanCmd[0], x.cleanCmd[1], { timeout: 10 * 60_000 });
    const after = existsSync(x.path) ? (await folderSize(x.path)).bytes : 0;
    const delta = Math.max(0, x.size - after);
    freed += delta;
    if (r.code === 0) s.succeed(t("clean.cachesDone", { name: x.label, size: formatBytes(delta) }));
    else s.fail(t("clean.cachesFailed", { name: x.label }) + " " + c.faint((r.stderr || r.stdout).trim().split("\n").pop() ?? ""));
  }
  blank();
  print(" " + status.ok(t("clean.freed", { size: c.brandBold(formatBytes(freed)), count: chosen.length })));
  blank();
}
