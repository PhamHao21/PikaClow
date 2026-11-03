import os from "node:os";
import { readCache, writeCache } from "../config.js";
import { cpuName, cpuCount, osName } from "../system/info.js";

export interface Gpu {
  vendor: string;
  model: string;
  /** Dedicated video memory in bytes (0 for integrated/shared). */
  vram: number;
  dedicated: boolean;
  /** Estimated memory bandwidth in GB/s. */
  bandwidth: number;
}

export interface Hardware {
  os: string;
  arch: string;
  cpu: string;
  threads: number;
  ramTotal: number;
  ramFree: number;
  memType: string | null;
  memSpeed: number | null;
  memModules: number;
  /** Estimated usable CPU memory bandwidth in GB/s. */
  cpuBandwidth: number;
  gpus: Gpu[];
  /** Apple Silicon: GPU shares system memory. */
  unified: boolean;
}

// Apple Silicon memory bandwidth (GB/s).
const APPLE: [RegExp, number][] = [
  [/M4 Max/i, 546], [/M4 Pro/i, 273], [/M4/i, 120],
  [/M3 Max/i, 400], [/M3 Pro/i, 150], [/M3/i, 100],
  [/M2 Ultra/i, 800], [/M2 Max/i, 400], [/M2 Pro/i, 200], [/M2/i, 100],
  [/M1 Ultra/i, 800], [/M1 Max/i, 400], [/M1 Pro/i, 200], [/M1/i, 68],
];

// Common NVIDIA/AMD cards (GB/s). Laptop variants are slower; matched first.
const GPU_BW: [RegExp, number][] = [
  [/5090/, 1790], [/5080/, 960], [/5070 Ti/, 896], [/5070/, 672], [/5060 Ti/, 448], [/5060/, 448],
  [/4090 Laptop/, 576], [/4090/, 1008], [/4080 Laptop/, 432], [/4080/, 717], [/4070 Ti/, 504], [/4070 Laptop/, 256], [/4070/, 504],
  [/4060 Ti/, 288], [/4060 Laptop/, 256], [/4060/, 272], [/4050/, 192],
  [/3090/, 936], [/3080 Ti/, 912], [/3080 Laptop/, 448], [/3080/, 760], [/3070 Ti/, 608], [/3070 Laptop/, 448], [/3070/, 448],
  [/3060 Ti/, 448], [/3060 Laptop/, 336], [/3060/, 360], [/3050 Laptop/, 192], [/3050/, 224],
  [/2080 Ti/, 616], [/2080/, 448], [/2070/, 448], [/2060/, 336], [/1660/, 192], [/1650/, 128], [/1080 Ti/, 484], [/1080/, 320], [/1070/, 256], [/1060/, 192],
  [/A100/, 1555], [/H100/, 2000], [/L4\b/, 300], [/T4\b/, 320],
  [/7900 XTX/, 960], [/7900 XT/, 800], [/7800 XT/, 624], [/7700 XT/, 432], [/7600/, 288], [/6950|6900/, 512], [/6800/, 512], [/6700/, 384], [/6600/, 224],
  [/Arc A770/, 560], [/Arc A750/, 512], [/Arc B580/, 456],
];

function guessGpuBandwidth(model: string, vramGb: number): number {
  for (const [re, bw] of GPU_BW) if (re.test(model)) return bw;
  if (vramGb >= 20) return 800;
  if (vramGb >= 12) return 450;
  if (vramGb >= 8) return 300;
  if (vramGb >= 6) return 250;
  return 150;
}

function isIntegrated(vendor: string, model: string, dynamic: boolean): boolean {
  if (dynamic) return true;
  if (/intel/i.test(vendor) && !/Arc\s+[AB]\d{3}/i.test(model)) return true;
  if (/amd|ati|advanced micro/i.test(vendor) && /Radeon\(TM\) Graphics|Radeon Graphics|Vega \d+ Graphics|780M|760M|680M|660M|610M/i.test(model)) return true;
  if (/apple/i.test(vendor)) return true;
  return false;
}

interface StaticHw {
  memType: string | null;
  memSpeed: number | null;
  memModules: number;
  gpus: Gpu[];
}

async function detectStatic(): Promise<StaticHw> {
  const si = (await import("systeminformation")).default;
  const [layout, graphics] = await Promise.all([si.memLayout().catch(() => []), si.graphics().catch(() => ({ controllers: [] }))]);
  const banks = layout.filter((m) => m.size > 0);
  const speeds = banks.map((m) => m.clockSpeed ?? 0).filter((s) => s > 0);
  const gpus: Gpu[] = [];
  for (const g of graphics.controllers) {
    const model = g.model ?? "GPU";
    const vendor = g.vendor ?? "";
    const vramMb = g.vram ?? 0;
    const integrated = isIntegrated(vendor, model, Boolean(g.vramDynamic));
    const vram = integrated ? 0 : vramMb * 1024 * 1024;
    gpus.push({ vendor, model, vram, dedicated: !integrated && vram > 0, bandwidth: integrated ? 0 : guessGpuBandwidth(model, vram / 1024 ** 3) });
  }
  return { memType: banks[0]?.type || null, memSpeed: speeds.length ? Math.min(...speeds) : null, memModules: banks.length, gpus };
}

/** Hardware facts for model sizing. Slow parts are cached for a week. */
export async function detectHardware(refresh = false): Promise<Hardware> {
  let st = refresh ? null : readCache<StaticHw>("hardware.json", 7 * 86400_000);
  if (!st) {
    st = await detectStatic();
    writeCache("hardware.json", st);
  }
  const cpu = cpuName();
  const unified = process.platform === "darwin" && os.arch() === "arm64";
  let cpuBandwidth: number;
  const apple = APPLE.find(([re]) => re.test(cpu));
  if (unified && apple) cpuBandwidth = apple[1];
  else if (st.memSpeed) {
    // Desktop DIMMs: one 64-bit channel per module (max 2 used by consumer CPUs).
    // LPDDR on laptops is soldered and normally runs a 128-bit bus.
    const lp = /LPDDR/i.test(st.memType ?? "");
    const channels = lp ? 2 : Math.max(1, Math.min(2, st.memModules));
    cpuBandwidth = ((st.memSpeed * 8 * channels) / 1000) * 0.45;
  } else {
    cpuBandwidth = os.totalmem() <= 8 * 1024 ** 3 ? 12 : 20;
  }
  return {
    os: osName(),
    arch: os.arch(),
    cpu,
    threads: cpuCount(),
    ramTotal: os.totalmem(),
    ramFree: os.freemem(),
    memType: st.memType,
    memSpeed: st.memSpeed,
    memModules: st.memModules,
    cpuBandwidth,
    gpus: st.gpus,
    unified,
  };
}
