import os from "node:os";

interface Times {
  idle: number;
  total: number;
}

function snapshot(): Times[] {
  return os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

/**
 * CPU load from the kernel's per-core counters (os.cpus()). No child processes,
 * effectively free to call every second.
 */
export class CpuSampler {
  private prev = snapshot();

  sample(): { total: number; cores: number[] } {
    const now = snapshot();
    const cores = now.map((n, i) => {
      const p = this.prev[i];
      if (!p) return 0;
      const total = n.total - p.total;
      const idle = n.idle - p.idle;
      return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
    });
    this.prev = now;
    const total = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0;
    return { total, cores };
  }
}
