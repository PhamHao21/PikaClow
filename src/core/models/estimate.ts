import type { Hardware } from "./hardware.js";
import { CATALOG, type CatalogModel, type Use } from "./catalog.js";

export type Fit = "gpu" | "split" | "cpu" | "tight" | "no";
export type Speed = "fast" | "good" | "ok" | "slow" | "none";

export interface Estimate {
  model: CatalogModel;
  /** Memory the model needs loaded (GB), including a 4k-token context. */
  needGB: number;
  fit: Fit;
  /** Estimated generation speed, tokens per second. */
  tps: number;
  speed: Speed;
}

const GB = 1024 ** 3;

export function speedOf(tps: number, fit: Fit): Speed {
  if (fit === "no") return "none";
  if (tps >= 25) return "fast";
  if (tps >= 10) return "good";
  if (tps >= 4) return "ok";
  return "slow";
}

/**
 * Token generation is limited by memory bandwidth: every token reads all active weights
 * once. tokens/s ≈ usable bandwidth / bytes read per token. Rough, but it ranks models
 * correctly and gets the order of magnitude right on typical hardware.
 */
export function estimate(m: CatalogModel, hw: Hardware): Estimate {
  const needGB = m.sizeGB * 1.12 + 0.5 + (m.params > 20 ? 1 : 0);
  const readGB = m.sizeGB * ((m.active ?? m.params) / m.params);
  const ramGB = hw.ramTotal / GB;
  const freeGB = hw.ramFree / GB;
  const cpuTps = hw.cpuBandwidth / Math.max(0.1, readGB);
  // CPUs with few threads also run out of compute on bigger models.
  const computeCap = (hw.threads * 22) / Math.max(0.3, m.active ?? m.params);
  const cpuOnly = Math.min(cpuTps, computeCap);

  let fit: Fit;
  let tps: number;
  if (hw.unified) {
    // Apple Silicon: the GPU can use roughly 70% of system memory.
    const usable = ramGB * 0.7;
    if (needGB <= usable) {
      fit = needGB <= freeGB + 1 ? "gpu" : "tight";
      tps = (hw.cpuBandwidth * 0.7) / Math.max(0.1, readGB);
    } else {
      fit = "no";
      tps = 0;
    }
    return { model: m, needGB, fit, tps, speed: speedOf(tps, fit) };
  }

  const gpu = hw.gpus.filter((g) => g.dedicated).sort((a, b) => b.vram - a.vram)[0];
  const vramGB = gpu ? gpu.vram / GB : 0;
  if (gpu && needGB <= vramGB * 0.95) {
    fit = "gpu";
    tps = (gpu.bandwidth * 0.7) / Math.max(0.1, readGB);
  } else if (gpu && vramGB >= 2 && needGB <= vramGB + ramGB * 0.75) {
    // Partial offload: the GPU holds some layers, the CPU streams the rest.
    const onGpu = Math.max(0, vramGB * 0.9 - 0.5) / needGB;
    const perToken = (readGB * onGpu) / (gpu.bandwidth * 0.7) + (readGB * (1 - onGpu)) / hw.cpuBandwidth;
    fit = "split";
    tps = 1 / perToken;
  } else if (needGB <= ramGB * 0.8) {
    fit = needGB <= freeGB + 0.5 ? "cpu" : "tight";
    tps = cpuOnly;
  } else {
    fit = "no";
    tps = 0;
  }
  return { model: m, needGB, fit, tps, speed: speedOf(tps, fit) };
}

export function estimateAll(hw: Hardware): Estimate[] {
  return CATALOG.map((m) => estimate(m, hw));
}

export interface Recommendation {
  use: "chat" | "code" | "quick";
  estimate: Estimate;
}

/**
 * Picks the best model per purpose: the most capable one that still runs at a usable
 * speed (≥ 8 tok/s for chat/code, ≥ 15 tok/s for quick tasks like commit messages).
 */
export function recommend(hw: Hardware, preferVi: boolean): Recommendation[] {
  const all = estimateAll(hw).filter((e) => e.fit !== "no");
  const pick = (use: Use, minTps: number, extra?: (e: Estimate) => boolean): Estimate | undefined => {
    const pool = all.filter((e) => e.model.uses.includes(use) && e.tps >= minTps && e.fit !== "tight" && (!extra || extra(e)));
    const rank = (e: Estimate) => e.model.params * (e.model.active ? 0.6 : 1) + (preferVi && e.model.vi ? 2 : 0);
    return pool.sort((a, b) => rank(b) - rank(a))[0];
  };
  const out: Recommendation[] = [];
  const chat = pick("chat", 8) ?? pick("chat", 4) ?? pick("chat", 0);
  if (chat) out.push({ use: "chat", estimate: chat });
  const code = pick("code", 8) ?? pick("code", 4);
  if (code && code.model.id !== chat?.model.id) out.push({ use: "code", estimate: code });
  const quick = pick("chat", 15, (e) => e.model.params >= 1.5) ?? pick("tiny", 8);
  if (quick && !out.some((r) => r.estimate.model.id === quick.model.id)) out.push({ use: "quick", estimate: quick });
  return out;
}
