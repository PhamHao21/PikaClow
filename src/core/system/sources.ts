import os from "node:os";
import { isWindows } from "../exec.js";
import { pwsh } from "../win/pwsh.js";
import { cpuCount } from "./info.js";

// Data sources for the dashboard and friends.
// Windows: one shared PowerShell session running .NET calls (fast, no process storms).
// macOS/Linux: systeminformation, which reads /proc or cheap native tools there.

const loadSi = async () => (await import("systeminformation")).default;

// ── Memory ─────────────────────────────────────────────────────────────────────
export interface MemoryInfo {
  total: number;
  used: number;
  free: number;
  pct: number;
  swapTotal: number;
  swapUsed: number;
}

export async function memory(): Promise<MemoryInfo> {
  const total = os.totalmem();
  const free = os.freemem();
  let swapTotal = 0;
  let swapUsed = 0;
  if (!isWindows) {
    try {
      const m = await (await loadSi()).mem();
      swapTotal = m.swaptotal;
      swapUsed = m.swapused;
      // os.freemem() on Linux ignores reclaimable cache; "available" is what users expect.
      if (m.available > 0) return { total, used: total - m.available, free: m.available, pct: ((total - m.available) / total) * 100, swapTotal, swapUsed };
    } catch {
      // fall through to os numbers
    }
  }
  return { total, used: total - free, free, pct: ((total - free) / total) * 100, swapTotal, swapUsed };
}

// ── Processes ──────────────────────────────────────────────────────────────────
export interface ProcInfo {
  pid: number;
  name: string;
  /** CPU % of the whole machine (0–100). */
  cpu: number;
  /** Resident memory in bytes. */
  mem: number;
}

const WIN_PROCS =
  '$o = foreach($p in [Diagnostics.Process]::GetProcesses()){ $c=0; try { $c=[long]$p.TotalProcessorTime.TotalMilliseconds } catch {}; "$($p.Id)|$($p.ProcessName)|$c|$($p.WorkingSet64)" }; [Console]::Out.Write($o -join "`n")';

export class ProcessSampler {
  private prevCpu = new Map<number, number>();
  private prevAt = 0;

  async sample(): Promise<ProcInfo[]> {
    return isWindows ? this.sampleWindows() : this.sampleUnix();
  }

  private async sampleWindows(): Promise<ProcInfo[]> {
    const out = await pwsh.run(WIN_PROCS);
    const now = performance.now();
    const elapsed = this.prevAt ? now - this.prevAt : 0;
    const ncpu = cpuCount();
    const next = new Map<number, number>();
    const list: ProcInfo[] = [];
    for (const line of out.split("\n")) {
      const [pidS, name, cpuS, memS] = line.split("|");
      const pid = Number(pidS);
      if (!Number.isFinite(pid) || pid === 0 || !name) continue;
      const cpuMs = Number(cpuS) || 0;
      next.set(pid, cpuMs);
      const before = this.prevCpu.get(pid);
      const cpu = elapsed > 0 && before !== undefined ? Math.max(0, Math.min(100, ((cpuMs - before) / (elapsed * ncpu)) * 100)) : 0;
      list.push({ pid, name, cpu, mem: Number(memS) || 0 });
    }
    // Only live PIDs are kept, so this never grows over time.
    this.prevCpu = next;
    this.prevAt = now;
    return list;
  }

  private async sampleUnix(): Promise<ProcInfo[]> {
    const si = await loadSi();
    const data = await si.processes();
    const ncpu = cpuCount();
    return data.list.map((p) => ({
      pid: p.pid,
      name: p.name,
      // systeminformation reports per-core percentages on some platforms.
      cpu: Math.max(0, Math.min(100, p.cpu > 100 ? p.cpu / ncpu : p.cpu)),
      mem: (p.memRss || 0) * 1024,
    }));
  }
}

// ── Network ────────────────────────────────────────────────────────────────────
export interface NetInfo {
  rxRate: number;
  txRate: number;
  rxTotal: number;
  txTotal: number;
  interfaces: string[];
}

const WIN_NET =
  '$o = foreach($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){ if($n.OperationalStatus -eq "Up" -and $n.NetworkInterfaceType -ne "Loopback" -and $n.NetworkInterfaceType -ne "Tunnel"){ $s=$n.GetIPStatistics(); "$($n.Name)|$($n.Description)|$($s.BytesReceived)|$($s.BytesSent)" } }; [Console]::Out.Write($o -join "`n")';

// Virtual adapters (WSL/Hyper-V/Docker/VPN) mirror real traffic and would double count it.
const VIRTUAL = /virtual|vethernet|hyper-v|vmware|virtualbox|loopback|pseudo|miniport|bluetooth|docker|wsl/i;

export class NetworkSampler {
  private prev: { rx: number; tx: number; at: number } | null = null;

  async sample(): Promise<NetInfo> {
    const { rx, tx, names } = isWindows ? await this.readWindows() : await this.readUnix();
    const at = performance.now();
    let rxRate = 0;
    let txRate = 0;
    if (this.prev) {
      const dt = (at - this.prev.at) / 1000;
      if (dt > 0) {
        rxRate = Math.max(0, (rx - this.prev.rx) / dt);
        txRate = Math.max(0, (tx - this.prev.tx) / dt);
      }
    }
    this.prev = { rx, tx, at };
    return { rxRate, txRate, rxTotal: rx, txTotal: tx, interfaces: names };
  }

  private async readWindows() {
    const out = await pwsh.run(WIN_NET);
    let rx = 0;
    let tx = 0;
    const names: string[] = [];
    for (const line of out.split("\n")) {
      const [name, desc, r, t] = line.split("|");
      if (!name || VIRTUAL.test(name) || VIRTUAL.test(desc ?? "")) continue;
      rx += Number(r) || 0;
      tx += Number(t) || 0;
      names.push(name);
    }
    return { rx, tx, names };
  }

  private async readUnix() {
    const si = await loadSi();
    const stats = await si.networkStats("*");
    let rx = 0;
    let tx = 0;
    const names: string[] = [];
    for (const s of stats) {
      if (!s.iface || s.iface === "lo" || s.iface.startsWith("lo") || VIRTUAL.test(s.iface) || /^(veth|br-|docker|utun|awdl|llw)/.test(s.iface)) continue;
      rx += s.rx_bytes || 0;
      tx += s.tx_bytes || 0;
      names.push(s.iface);
    }
    return { rx, tx, names };
  }
}

// ── Disks ──────────────────────────────────────────────────────────────────────
export interface DiskInfo {
  mount: string;
  label: string;
  total: number;
  free: number;
  used: number;
  pct: number;
}

const WIN_DRIVES =
  '$o = foreach($d in [IO.DriveInfo]::GetDrives()){ if($d.IsReady -and $d.DriveType -eq "Fixed"){ "$($d.Name)|$($d.VolumeLabel)|$($d.TotalSize)|$($d.AvailableFreeSpace)" } }; [Console]::Out.Write($o -join "`n")';

export async function disks(): Promise<DiskInfo[]> {
  if (isWindows) {
    const out = await pwsh.run(WIN_DRIVES);
    return out
      .split("\n")
      .map((line) => {
        const [mount, label, totalS, freeS] = line.split("|");
        const total = Number(totalS) || 0;
        const free = Number(freeS) || 0;
        return { mount: (mount ?? "").replace(/\\$/, ""), label: label ?? "", total, free, used: total - free, pct: total ? ((total - free) / total) * 100 : 0 };
      })
      .filter((d) => d.mount && d.total > 0);
  }
  const si = await loadSi();
  const list = await si.fsSize();
  const seen = new Set<string>();
  return list
    .filter((d) => d.size > 1024 ** 3 && !/^(tmpfs|devtmpfs|overlay|squashfs|autofs|devfs|nullfs)$/i.test(d.type) && !/^\/(snap|boot\/efi|System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware))/.test(d.mount))
    .filter((d) => {
      // APFS volumes share one container; keep one entry per device size.
      const key = `${d.fs}:${d.size}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((d) => ({ mount: d.mount, label: "", total: d.size, free: d.available, used: d.size - d.available, pct: d.size ? ((d.size - d.available) / d.size) * 100 : 0 }));
}

// ── Battery ────────────────────────────────────────────────────────────────────
export interface BatteryInfo {
  percent: number;
  charging: boolean;
  plugged: boolean;
  /** Minutes remaining, when known. */
  remaining: number | null;
}

const WIN_BATTERY =
  'Add-Type -AssemblyName System.Windows.Forms; $s=[Windows.Forms.SystemInformation]::PowerStatus; [Console]::Out.Write("$($s.BatteryChargeStatus)|$($s.BatteryLifePercent)|$($s.PowerLineStatus)|$($s.BatteryLifeRemaining)")';

export async function battery(): Promise<BatteryInfo | null> {
  if (isWindows) {
    const out = await pwsh.run(WIN_BATTERY);
    const [status, pctS, line, remainS] = out.split("|");
    if (!status || /NoSystemBattery|Unknown/i.test(status)) return null;
    const pct = Math.round((Number(pctS) || 0) * 100);
    if (pct > 100) return null;
    const remain = Number(remainS);
    return { percent: pct, charging: /Charging/i.test(status), plugged: line === "Online", remaining: remain > 0 ? Math.round(remain / 60) : null };
  }
  const si = await loadSi();
  const b = await si.battery();
  if (!b.hasBattery) return null;
  return { percent: b.percent, charging: b.isCharging, plugged: b.acConnected, remaining: b.timeRemaining > 0 ? b.timeRemaining : null };
}
