import os from "node:os";
import { readFileSync } from "node:fs";

/** Human OS name. Fixes Windows 11 reporting itself as "Windows 10" and maps Darwin → macOS. */
export function osName(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const build = Number(os.release().split(".")[2] ?? 0);
    let name = os.version() || "Windows";
    if (build >= 22000) name = name.replace("Windows 10", "Windows 11");
    return `${name} (build ${build})`;
  }
  if (platform === "darwin") {
    const major = Number(os.release().split(".")[0] ?? 0);
    const names: Record<number, string> = {
      20: "macOS 11 Big Sur", 21: "macOS 12 Monterey", 22: "macOS 13 Ventura",
      23: "macOS 14 Sonoma", 24: "macOS 15 Sequoia", 25: "macOS 26 Tahoe",
    };
    return names[major] ?? `macOS (Darwin ${os.release()})`;
  }
  try {
    const rel = readFileSync("/etc/os-release", "utf8");
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel);
    if (m?.[1]) return m[1];
  } catch {
    // not every Linux has os-release
  }
  return `${os.type()} ${os.release()}`;
}

/** "11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz" → "Intel Core i3-1115G4". */
export function cleanCpuName(raw: string): string {
  return raw
    .replace(/\((R|TM|tm|r)\)|®|™/g, "")
    .replace(/\d+(st|nd|rd|th) Gen /i, "")
    .replace(/ CPU/i, "")
    .replace(/ @ .*$/, "")
    .replace(/\s+Processor$/i, "")
    .replace(/\s*\d+-Core\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cpuName(): string {
  return cleanCpuName(os.cpus()[0]?.model ?? "Unknown CPU");
}

export function cpuCount(): number {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
