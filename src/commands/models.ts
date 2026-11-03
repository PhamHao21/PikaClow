import { OllamaProvider } from "../core/ai/ollama.js";
import { createProvider } from "../core/ai/index.js";
import type { ModelInfo } from "../core/ai/provider.js";
import { loadConfig, saveConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { isMac, isWindows } from "../core/exec.js";
import { formatBytes } from "../core/format.js";
import { CATALOG, type CatalogModel } from "../core/models/catalog.js";
import { estimate, estimateAll, recommend, speedOf, type Estimate, type Fit, type Speed } from "../core/models/estimate.js";
import { detectHardware, type Hardware } from "../core/models/hardware.js";
import { getLang, t } from "../i18n/index.js";
import { bar, box, cmd, meter, status, table, titleBlock } from "../ui/components.js";
import { LiveRegion } from "../ui/live.js";
import { blank, print, printJson } from "../ui/print.js";
import { isCancel, select } from "../ui/prompts.js";
import { spinner } from "../ui/spinner.js";
import { columns, isInteractive } from "../ui/terminal.js";
import { c, P, sym } from "../ui/theme.js";
import { fit } from "../ui/text.js";

export interface ModelsOptions {
  all?: boolean;
  json?: boolean;
  pull?: string;
  use?: string;
  refresh?: boolean;
}

const GB = 1024 ** 3;

/** Speed as a 5-segment LED meter plus the number. */
function speedBadge(s: Speed, tps: number): string {
  const n = tps >= 10 ? tps.toFixed(0) : tps.toFixed(1);
  const [level, paint] = ({ fast: [5, c.ok], good: [4, c.ok], ok: [3, c.warn], slow: [1, c.err], none: [0, c.faint] } as const)[s];
  if (s === "none") return meter(0, c.faint) + " " + c.faint("–");
  return meter(level, paint) + " " + paint(`~${n} tok/s`);
}

function fitLabel(f: Fit): string {
  switch (f) {
    case "gpu":
      return c.tile("GPU", P.ok);
    case "split":
      return c.tile("GPU+CPU", P.warn);
    case "cpu":
      return c.tile("CPU", P.brandSoft);
    case "tight":
      return c.warn(t("models.fitTight"));
    default:
      return c.err(t("models.fitNo"));
  }
}

function useLabel(m: CatalogModel): string {
  const tags = m.uses.filter((u) => u !== "tiny").map((u) => t(`models.use.${u}` as "models.use.chat"));
  if (m.vi) tags.push("VI");
  if (m.active) tags.push("MoE");
  return tags.join(" · ");
}

/** Estimates for installed models that are not in the catalog, from their real size. */
function estimateInstalled(info: ModelInfo, hw: Hardware): Estimate | null {
  if (!info.size) return null;
  const params = Number(/([\d.]+)\s*B/i.exec(info.parameters ?? "")?.[1] ?? 0) || info.size / GB / 0.6;
  const m: CatalogModel = { id: info.name, name: info.name, params, sizeGB: info.size / GB, uses: ["chat"], vi: false };
  return estimate(m, hw);
}

function hardwarePanel(hw: Hardware, w: number): string[] {
  const used = ((hw.ramTotal - hw.ramFree) / hw.ramTotal) * 100;
  const mem = [hw.memType, hw.memSpeed ? `${hw.memSpeed} MT/s` : null, hw.memModules ? `×${hw.memModules}` : null].filter(Boolean).join(" ");
  const lines = [
    c.muted(fit(t("models.hwCpu"), 10)) + c.bold(hw.cpu) + c.faint(`  ${hw.threads} ${t("dash.threads")}`),
    c.muted(fit("RAM", 10)) + bar(used, 16) + "  " + c.bold(formatBytes(hw.ramTotal)) + c.muted("  " + t("dash.free", { size: formatBytes(hw.ramFree) })) + (mem ? c.faint("  " + mem) : ""),
    c.muted(fit(t("models.hwBandwidth"), 10)) + c.soft(`~${hw.cpuBandwidth.toFixed(0)} GB/s`) + c.faint("  " + t("models.bandwidthNote")),
  ];
  if (hw.unified) lines.push(c.muted(fit("GPU", 10)) + c.ok(t("models.unified")));
  for (const g of hw.gpus) {
    lines.push(
      c.muted(fit("GPU", 10)) +
        c.bold(g.model) +
        (g.dedicated ? c.ok(`  ${formatBytes(g.vram)} VRAM`) + c.faint(`  ~${g.bandwidth} GB/s`) : c.faint("  " + t("models.integrated"))),
    );
  }
  return box(lines, { title: t("models.hardware"), width: w });
}

function installHint(): string[] {
  if (isWindows) return ["winget install Ollama.Ollama", "https://ollama.com/download"];
  if (isMac) return ["brew install ollama", "https://ollama.com/download"];
  return ["curl -fsSL https://ollama.com/install.sh | sh", "https://ollama.com/download"];
}

async function pullModel(provider: OllamaProvider, id: string, ctx: Ctx): Promise<boolean> {
  const region = new LiveRegion();
  let last = "";
  const w = Math.min(40, columns() - 40);
  try {
    await provider.pull(
      id,
      (st, frac) => {
        const label = st.startsWith("pulling ") ? t("models.downloading") : st;
        const line = frac !== null ? c.brand(sym("down")) + " " + fit(id, 18) + " " + bar(frac * 100, w, c.brand) + " " + fit((frac * 100).toFixed(0) + "%", 4, "right") : c.brand(sym("pointerSmall")) + " " + fit(id, 18) + " " + c.muted(label);
        if (line !== last) {
          last = line;
          region.render([line]);
        }
      },
      ctx.signal,
    );
    region.render([status.ok(t("models.pulled", { model: c.bold(id) }))]);
    region.done();
    return true;
  } catch (e) {
    region.dispose();
    throw e;
  }
}

function setDefault(id: string): void {
  const prev = loadConfig().ai;
  saveConfig({ ai: { ...(prev ?? {}), provider: "ollama", model: id } });
  print(status.ok(t("models.nowDefault", { model: c.bold(id) })));
}

export async function modelsCommand(opts: ModelsOptions, ctx: Ctx): Promise<void> {
  const spin = opts.json ? null : spinner(t("models.detecting"));
  const provider = createProvider();
  const ollama = provider instanceof OllamaProvider ? provider : new OllamaProvider(undefined, undefined);
  const [hw, st] = await Promise.all([detectHardware(Boolean(opts.refresh)), ollama.status()]);
  const installed: ModelInfo[] = st.ok ? await ollama.models().catch(() => []) : [];
  spin?.stop();
  const installedNames = new Set(installed.map((m) => m.name));
  const isInstalled = (id: string) => installedNames.has(id) || installedNames.has(id + ":latest");
  const recs = recommend(hw, getLang() === "vi");

  // Direct actions.
  if (opts.use) {
    setDefault(opts.use);
    return;
  }
  if (opts.pull) {
    if (!st.ok) throw ollama.offline();
    if (await pullModel(ollama, opts.pull, ctx)) setDefault(opts.pull);
    return;
  }

  const all = estimateAll(hw);
  if (opts.json) {
    return printJson({
      hardware: { ...hw, ramTotalGB: +(hw.ramTotal / GB).toFixed(1), ramFreeGB: +(hw.ramFree / GB).toFixed(1) },
      ollama: { running: st.ok, version: st.version ?? null, url: ollama.baseUrl, installed: installed.map((m) => m.name) },
      recommendations: recs.map((r) => ({ use: r.use, model: r.estimate.model.id, tokensPerSecond: +r.estimate.tps.toFixed(1), fit: r.estimate.fit })),
      models: all.map((e) => ({ id: e.model.id, sizeGB: e.model.sizeGB, needGB: +e.needGB.toFixed(1), fit: e.fit, tokensPerSecond: +e.tps.toFixed(1), speed: e.speed, installed: isInstalled(e.model.id) })),
    });
  }

  const W = Math.min(columns() - 2, 110);
  blank();
  print(...titleBlock("MODELS", t("models.subtitle")));
  blank();
  print(...hardwarePanel(hw, W).map((l) => " " + l));

  // Runtime status.
  const current = loadConfig().ai;
  const runtime: string[] = [];
  if (st.ok) {
    runtime.push(c.ok(sym("dot")) + " " + t("models.ollamaRunning", { version: st.version ?? "?", url: ollama.baseUrl }));
    runtime.push(c.muted(fit(t("models.installed"), 12)) + (installed.length ? installed.map((m) => (m.name === current?.model ? c.brandBold(m.name) : m.name)).join(c.faint(", ")) : c.faint(t("models.noneInstalled"))));
  } else {
    runtime.push(c.err(sym("circle")) + " " + t("models.ollamaMissing", { url: ollama.baseUrl }));
    for (const h of installHint()) runtime.push("  " + cmd(h));
  }
  if (current?.provider === "openai") runtime.push(c.muted(fit(t("models.current"), 12)) + t("models.usingApi", { model: current.model ?? "?", url: current.baseUrl ?? "" }));
  else if (current?.model) runtime.push(c.muted(fit(t("models.current"), 12)) + c.brandBold(current.model));
  print(...box(runtime, { title: t("models.runtime"), width: W }).map((l) => " " + l));

  // Recommendations.
  if (recs.length) {
    const lines = recs.map((r) => {
      const e = r.estimate;
      const tag = c.brand(fit(t(`models.rec.${r.use}` as "models.rec.chat"), 14));
      const action = isInstalled(e.model.id) ? c.ok(sym("ok") + " " + t("models.isInstalled")) : cmd(`ollama pull ${e.model.id}`);
      return tag + c.bold(fit(e.model.id, 20)) + fit(speedBadge(e.speed, e.tps), 22) + c.muted(fit(t("models.needs", { gb: e.needGB.toFixed(1) }), 14)) + action;
    });
    lines.push(c.faint(t("models.estimateNote")));
    print(...box(lines, { title: t("models.recommended"), width: W }).map((l) => " " + l));
  }

  // Full table: everything that fits, plus the first few that do not.
  const fits = all.filter((e) => e.fit !== "no");
  const nofit = all.filter((e) => e.fit === "no");
  const shown = opts.all ? all : [...fits, ...nofit.slice(0, 2)];
  blank();
  const rows = shown.map((e) => [
    (isInstalled(e.model.id) ? c.ok(sym("ok") + " ") : "  ") + (e.fit === "no" ? c.faint(e.model.id) : c.bold(e.model.id)),
    fit(`${e.model.sizeGB < 1 ? e.model.sizeGB.toFixed(2) : e.model.sizeGB.toFixed(1)} GB`, 8, "right"),
    fitLabel(e.fit),
    speedBadge(e.speed, e.tps),
    c.muted(useLabel(e.model)),
  ]);
  // Installed models we do not know about.
  for (const m of installed) {
    if (CATALOG.some((x) => x.id === m.name || x.id + ":latest" === m.name)) continue;
    const e = estimateInstalled(m, hw);
    if (!e) continue;
    rows.push([c.ok(sym("ok") + " ") + c.bold(m.name), fit(formatBytes(m.size ?? 0), 8, "right"), fitLabel(e.fit), speedBadge(speedOf(e.tps, e.fit), e.tps), c.muted(m.parameters ?? "")]);
  }
  print(
    ...table(
      [
        { header: t("models.colModel"), min: 14 },
        { header: t("models.colDownload"), align: "right" },
        { header: t("models.colRuns") },
        { header: t("models.colSpeed") },
        { header: t("models.colGoodFor"), grow: true, min: 8 },
      ],
      rows,
      W,
    ).map((l) => " " + l),
  );
  if (!opts.all && nofit.length > 2) print(" " + c.faint(t("models.moreHidden", { n: nofit.length - 2, flag: "--all" })));
  blank();

  // Offer to download/select a model.
  if (!isInteractive() || !st.ok) {
    if (st.ok && recs[0]) print(" " + status.hint(t("models.pullHint", { cmd: cmd(`pikaclow models --pull ${recs[0].estimate.model.id}`) })));
    blank();
    return;
  }
  const options = [
    ...recs.map((r) => ({
      value: r.estimate.model.id,
      label: `${r.estimate.model.id}`,
      hint: `${t(`models.rec.${r.use}` as "models.rec.chat")} · ${isInstalled(r.estimate.model.id) ? t("models.isInstalled") : `${r.estimate.model.sizeGB.toFixed(1)} GB`}`,
    })),
    ...installed.filter((m) => !recs.some((r) => r.estimate.model.id === m.name)).map((m) => ({ value: m.name, label: m.name, hint: t("models.isInstalled") })),
    { value: "__other", label: t("models.other"), hint: "" },
    { value: "", label: t("prompt.nothing"), hint: "" },
  ];
  const pick = await select({ message: t("models.pickPrompt"), options, signal: ctx.signal });
  if (isCancel(pick) || !pick) {
    blank();
    return;
  }
  let id = pick;
  if (pick === "__other") {
    const other = await select({
      message: t("models.pickAny"),
      options: fits.map((e) => ({ value: e.model.id, label: e.model.id, hint: `${e.model.sizeGB.toFixed(1)} GB · ${e.tps.toFixed(1)} tok/s` })),
      signal: ctx.signal,
    });
    if (isCancel(other)) return;
    id = other;
  }
  if (!isInstalled(id)) {
    if (!(await pullModel(ollama, id, ctx))) return;
  }
  setDefault(id);
  print(" " + status.hint(t("models.tryIt", { cmd: cmd("pikaclow ask \"hello\"") })));
  blank();
}
