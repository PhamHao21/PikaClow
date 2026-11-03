import os from "node:os";
import { CpuSampler } from "../core/system/cpu.js";
import { battery, disks, memory, NetworkSampler, ProcessSampler, type BatteryInfo, type DiskInfo, type MemoryInfo, type NetInfo, type ProcInfo } from "../core/system/sources.js";
import { cpuCount, cpuName, formatUptime, osName } from "../core/system/info.js";
import { formatBytes, formatRate } from "../core/format.js";
import { isSystemProcess, killProcess } from "../core/ports.js";
import { pwsh } from "../core/win/pwsh.js";
import type { Ctx } from "../core/context.js";
import { t } from "../i18n/index.js";
import { bar, box, sparkline } from "../ui/components.js";
import { isCtrlC, isEnter, isEscape, pushKeys, type Key } from "../ui/keys.js";
import { print } from "../ui/print.js";
import { FullScreen } from "../ui/screen.js";
import { columns, isInteractive } from "../ui/terminal.js";
import { c, levelColor, P, sym } from "../ui/theme.js";
import { fit, padEnd, truncate, width } from "../ui/text.js";
import { smallLogo } from "../ui/logo.js";

export interface DashOptions {
  once?: boolean;
  view?: View;
}

type View = "overview" | "processes";
type Sort = "cpu" | "mem" | "name";

interface Row {
  pid: number;
  pids: number[];
  name: string;
  cpu: number;
  mem: number;
  count: number;
}

const HISTORY = 120;

/** Repeats an async job, waiting for each run to finish first — calls can never pile up. */
class Poller<T> {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  constructor(
    private fn: () => Promise<T>,
    private interval: number,
    private onData: (d: T) => void,
    private paused: () => boolean = () => false,
  ) {}
  start(delay = 0): this {
    this.timer = setTimeout(() => void this.tick(), delay);
    return this;
  }
  async now(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.tick();
  }
  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.paused()) {
      try {
        const d = await this.fn();
        if (!this.stopped) this.onData(d);
      } catch {
        // A failed sample just keeps the previous values on screen.
      }
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.interval);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

const push = (arr: number[], v: number) => {
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
};

class Dashboard {
  view: View;
  cpu = { total: 0, cores: [] as number[] };
  cpuHist: number[] = [];
  memHist: number[] = [];
  rxHist: number[] = [];
  txHist: number[] = [];
  mem: MemoryInfo | null = null;
  net: NetInfo | null = null;
  disks: DiskInfo[] = [];
  battery: BatteryInfo | null = null;
  procs: ProcInfo[] = [];
  sort: Sort = "cpu";
  group = false;
  filter = "";
  filtering = false;
  selected = 0;
  scroll = 0;
  paused = false;
  confirm: Row | null = null;
  flash: { text: string; until: number; ok: boolean } | null = null;
  self = { cpu: 0, mem: 0 };
  private selfPrev = { usage: process.cpuUsage(), at: performance.now() };
  private cpuSampler = new CpuSampler();
  private procSampler = new ProcessSampler();
  private netSampler = new NetworkSampler();
  private pollers: Poller<unknown>[] = [];
  private host = os.hostname();
  private osLabel = osName().replace(/\s*\(build \d+\)/, "");
  private cpuLabel = cpuName();
  private ncpu = cpuCount();

  constructor(view: View) {
    this.view = view;
  }

  startPolling(render: () => void): void {
    const paused = () => this.paused;
    this.pollers = [
      new Poller(async () => this.cpuSampler.sample(), 1000, (d) => {
        this.cpu = d;
        push(this.cpuHist, d.total);
        this.sampleSelf();
        render();
      }, paused).start(300),
      new Poller(memory, 1000, (d) => {
        this.mem = d;
        push(this.memHist, d.pct);
        render();
      }, paused).start(0),
      new Poller(() => this.netSampler.sample(), 2000, (d) => {
        this.net = d;
        if (this.rxHist.length || d.rxRate || d.txRate) {
          push(this.rxHist, d.rxRate);
          push(this.txHist, d.txRate);
        }
        render();
      }, paused).start(0),
      new Poller(() => this.procSampler.sample(), 2000, (d) => {
        this.procs = d;
        render();
      }, paused).start(0),
      new Poller(disks, 15000, (d) => {
        this.disks = d;
        render();
      }, paused).start(200),
      new Poller(battery, 30000, (d) => {
        this.battery = d;
        render();
      }, paused).start(400),
    ] as Poller<unknown>[];
  }

  stop(): void {
    for (const p of this.pollers) p.stop();
  }

  refresh(): void {
    for (const p of this.pollers) void p.now();
  }

  private sampleSelf(): void {
    const now = performance.now();
    const usage = process.cpuUsage(this.selfPrev.usage);
    const elapsed = now - this.selfPrev.at;
    this.selfPrev = { usage: process.cpuUsage(), at: now };
    const helper = pwsh.pid ? this.procs.find((p) => p.pid === pwsh.pid) : undefined;
    this.self = {
      cpu: (elapsed > 0 ? ((usage.user + usage.system) / 1000 / elapsed / this.ncpu) * 100 : 0) + (helper?.cpu ?? 0),
      mem: process.memoryUsage().rss + (helper?.mem ?? 0),
    };
  }

  // ── Data shaping ─────────────────────────────────────────────────────────────
  rows(): Row[] {
    let rows: Row[];
    if (this.group) {
      const map = new Map<string, Row>();
      for (const p of this.procs) {
        const key = p.name.toLowerCase();
        const r = map.get(key);
        if (r) {
          r.cpu += p.cpu;
          r.mem += p.mem;
          r.count++;
          r.pids.push(p.pid);
        } else map.set(key, { pid: p.pid, pids: [p.pid], name: p.name, cpu: p.cpu, mem: p.mem, count: 1 });
      }
      rows = [...map.values()];
    } else {
      rows = this.procs.map((p) => ({ pid: p.pid, pids: [p.pid], name: p.name, cpu: p.cpu, mem: p.mem, count: 1 }));
    }
    const f = this.filter.toLowerCase();
    if (f) rows = rows.filter((r) => r.name.toLowerCase().includes(f) || String(r.pid).startsWith(f));
    const by: Record<Sort, (a: Row, b: Row) => number> = {
      cpu: (a, b) => b.cpu - a.cpu || b.mem - a.mem,
      mem: (a, b) => b.mem - a.mem,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return rows.sort(by[this.sort]);
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  render(W: number, H: number, interactive = true): string[] {
    if (W < 50 || H < 14) {
      return [c.warn(" " + t("dash.tooSmall", { w: 50, h: 14 }))];
    }
    const lines: string[] = [];
    lines.push(this.headerLine(W));
    if (interactive) lines.push(this.tabsLine(W));
    const footerRows = interactive ? 1 : 0;
    const bodyH = H - lines.length - footerRows;
    const body = this.view === "overview" ? this.overview(W, bodyH) : this.processView(W, bodyH);
    lines.push(...body.slice(0, bodyH));
    while (interactive && lines.length < H - footerRows) lines.push("");
    if (interactive) lines.push(this.footerLine(W));
    return lines;
  }

  private headerLine(W: number): string {
    const left = " " + smallLogo() + " " + c.tile(t("dash.title").toUpperCase()) + "  " + c.muted(`${this.host} · ${this.osLabel} · ${t("dash.up")} ${formatUptime(os.uptime())}`);
    const parts: string[] = [];
    if (this.battery) {
      const b = this.battery;
      const color = b.percent <= 20 && !b.plugged ? c.err : b.charging ? c.ok : c.muted;
      parts.push(color(`${t("dash.battery")} ${b.percent}%${b.charging ? " " + sym("up") : ""}`));
    }
    if (this.paused) parts.push(c.warn(t("dash.paused")));
    parts.push(c.soft(new Date().toLocaleTimeString()));
    const right = parts.join(c.faint(" · ")) + " ";
    const gap = W - width(left) - width(right);
    return gap >= 1 ? left + " ".repeat(gap) + right : truncate(left, W);
  }

  private tabsLine(W: number): string {
    // Pixel tabs: the active one is a solid tile.
    const tab = (key: string, label: string, on: boolean) => (on ? c.tile(`${key} ${label.toUpperCase()}`) : c.seg(`${key} ${label.toUpperCase()}`, P.panel, P.muted));
    const count = this.procs.length ? c.faint(`  ${t("dash.procCount", { n: this.procs.length })}`) : "";
    return truncate(" " + tab("1", t("dash.tabOverview"), this.view === "overview") + " " + tab("2", t("dash.tabProcesses"), this.view === "processes") + count, W);
  }

  private footerLine(W: number): string {
    if (this.confirm) {
      const r = this.confirm;
      const who = r.count > 1 ? t("dash.killGroup", { n: r.count, name: r.name }) : `${r.name} (PID ${r.pid})`;
      const sys = isSystemProcess(r.pid, r.name) ? " " + c.err(t("dash.systemWarn")) : "";
      return truncate(" " + c.warn(sym("warn") + " " + t("dash.confirmKill", { who })) + sys + c.muted("  [y/N]"), W);
    }
    if (this.filtering) {
      return truncate(" " + c.brand("/") + " " + this.filter + c.inverse(" ") + c.faint("   " + t("dash.filterHint")), W);
    }
    if (this.flash && Date.now() < this.flash.until) {
      return truncate(" " + (this.flash.ok ? c.ok(sym("ok") + " ") : c.err(sym("fail") + " ")) + this.flash.text, W);
    }
    const k = (key: string, label: string) => c.keycap(key) + " " + c.muted(label);
    const hints = [
      k("q", t("dash.kQuit")),
      k("tab", t("dash.kView")),
      k("s", t("dash.kSort", { sort: t(`dash.sort.${this.sort}` as "dash.sort.cpu") })),
      k("g", t(this.group ? "dash.kUngroup" : "dash.kGroup")),
      k("/", t("dash.kFilter")),
      k("k", t("dash.kKill")),
      k("p", t(this.paused ? "dash.kResume" : "dash.kPause")),
    ].join(" ");
    const self = c.faint(t("dash.self", { cpu: this.self.cpu.toFixed(1), mem: formatBytes(this.self.mem, 0) })) + " ";
    const gap = W - width(hints) - width(self) - 1;
    return gap >= 2 ? " " + hints + " ".repeat(gap) + self : truncate(" " + hints, W);
  }

  private cpuPanel(w: number): string[] {
    const iw = w - 4;
    const total = this.cpu.total;
    const lines = [
      c.muted(t("dash.total").padEnd(6)) + bar(total, Math.max(6, iw - 13)) + " " + levelColor(total)(fit(total.toFixed(1) + "%", 6, "right")),
      sparkline(this.cpuHist, iw, 100, c.brand),
    ];
    const cores = this.cpu.cores;
    if (cores.length && cores.length <= 8) {
      const colW = Math.floor((iw - 2) / 2);
      for (let i = 0; i < cores.length; i += 2) {
        const cell = (j: number) => {
          const v = cores[j];
          if (v === undefined) return "";
          return c.faint(fit(String(j), 3)) + bar(v, Math.max(4, colW - 9)) + " " + levelColor(v)(fit(v.toFixed(0) + "%", 4, "right"));
        };
        lines.push(padEnd(cell(i), colW) + "  " + cell(i + 1));
      }
    } else if (cores.length) {
      // Many cores: one colored block per core.
      const blocks = cores.map((v) => levelColor(v)(["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"][Math.min(7, Math.floor(v / 12.5))]!));
      for (let i = 0; i < blocks.length; i += iw) lines.push(blocks.slice(i, i + iw).join(""));
    }
    return box(lines, { title: `${t("dash.cpu")} · ${this.cpuLabel} · ${this.ncpu} ${t("dash.threads")}`, width: w });
  }

  private memPanel(w: number): string[] {
    const iw = w - 4;
    const m = this.mem;
    const lines: string[] = [];
    if (m) {
      lines.push(c.muted("RAM".padEnd(6)) + bar(m.pct, Math.max(6, iw - 13)) + " " + levelColor(m.pct)(fit(m.pct.toFixed(1) + "%", 6, "right")));
      lines.push(c.muted(" ".repeat(6)) + c.bold(formatBytes(m.used)) + c.muted(" / " + formatBytes(m.total)) + c.faint("  ·  ") + c.ok(t("dash.free", { size: formatBytes(m.free) })));
      lines.push(sparkline(this.memHist, iw, 100, c.soft));
      if (m.swapTotal > 0) {
        const sp = (m.swapUsed / m.swapTotal) * 100;
        lines.push(c.muted("Swap".padEnd(6)) + bar(sp, Math.max(6, iw - 13)) + " " + levelColor(sp)(fit(sp.toFixed(1) + "%", 6, "right")));
      }
    } else lines.push(c.faint(t("dash.loading")));
    if (this.battery) {
      const b = this.battery;
      const extra = b.charging ? c.ok(" " + t("dash.charging")) : b.remaining ? c.muted(" " + t("dash.remaining", { time: formatUptime(b.remaining * 60) })) : "";
      lines.push(c.muted(t("dash.batteryShort").padEnd(6)) + bar(b.percent, Math.max(6, iw - 13), b.percent <= 20 ? c.err : c.ok) + " " + fit(b.percent + "%", 6, "right") + extra);
    }
    return box(lines, { title: t("dash.memory"), width: w });
  }

  private netPanel(w: number): string[] {
    const iw = w - 4;
    const n = this.net;
    const lines: string[] = [];
    if (n) {
      const sw = Math.max(4, iw - 14);
      const top = Math.max(64 * 1024, ...this.rxHist, ...this.txHist);
      lines.push(c.info(sym("down")) + " " + c.bold(fit(formatRate(n.rxRate), 11, "right")) + " " + sparkline(this.rxHist, sw, top, c.info));
      lines.push(c.brand(sym("up")) + " " + c.bold(fit(formatRate(n.txRate), 11, "right")) + " " + sparkline(this.txHist, sw, top, c.brand));
      lines.push(c.faint(t("dash.netTotal", { rx: formatBytes(n.rxTotal), tx: formatBytes(n.txTotal) }) + (n.interfaces.length ? "  ·  " + n.interfaces.slice(0, 2).join(", ") : "")));
    } else lines.push(c.faint(t("dash.loading")));
    return box(lines, { title: t("dash.network"), width: w });
  }

  private diskPanel(w: number): string[] {
    const iw = w - 4;
    const lines = this.disks.slice(0, 4).map((d) => {
      const right = " " + levelColor(d.pct)(fit(d.pct.toFixed(0) + "%", 4, "right")) + c.muted(fit(`${formatBytes(d.free, 0)} ${t("dash.freeShort")}`, 12, "right"));
      const label = fit(d.mount, 6);
      return c.bold(label) + bar(d.pct, Math.max(4, iw - 6 - width(right))) + right;
    });
    if (!lines.length) lines.push(c.faint(t("dash.loading")));
    return box(lines, { title: t("dash.disks"), width: w });
  }

  private procTable(w: number, h: number, withSelection: boolean): string[] {
    const rows = this.rows();
    const iw = w - 4;
    const barW = Math.max(4, Math.min(12, Math.floor(iw / 8)));
    const nameW = Math.max(8, iw - 8 - (barW + 7) - 10 - 3 - (this.group ? 5 : 0));
    const headerLine = c.headerBar(
      padEnd(fit("PID", 7, "right") + " " + fit(t("dash.colName"), nameW) + " " + (this.group ? fit("#", 4, "right") + " " : "") + fit("CPU", barW + 6) + " " + fit(t("dash.colMem"), 9, "right"), iw),
    );
    const visible = Math.max(1, h - 3);
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
    const start = withSelection ? this.scroll : 0;
    const body = rows.slice(start, start + visible).map((r, j) => {
      const i = start + j;
      const cpuCell = bar(r.cpu, barW) + " " + levelColor(r.cpu)(fit(r.cpu.toFixed(1), 5, "right"));
      const name = r.count > 1 ? r.name : r.name;
      const line =
        c.faint(fit(r.count > 1 ? "·" : String(r.pid), 7, "right")) + " " + fit(name, nameW) + " " + (this.group ? c.muted(fit("×" + r.count, 4, "right")) + " " : "") + cpuCell + " " + fit(formatBytes(r.mem, 0), 9, "right");
      return withSelection && i === this.selected ? c.selected(padEnd(line, iw)) : line;
    });
    if (!rows.length) body.push(c.faint(this.procs.length ? t("dash.noMatch") : t("dash.loading")));
    const sortLabel = t(`dash.sort.${this.sort}` as "dash.sort.cpu");
    const title = withSelection ? t("dash.processesTitle", { sort: sortLabel }) + (this.filter ? ` · "${this.filter}"` : "") : t("dash.topProcesses");
    const boxed = box([headerLine, ...body], { title, width: w });
    while (boxed.length < h) boxed.splice(boxed.length - 1, 0, box([""], { width: w })[1]!);
    return boxed;
  }

  private overview(W: number, H: number): string[] {
    const out: string[] = [];
    const wide = W >= 96;
    if (wide) {
      const colW = Math.floor((W - 3) / 2);
      const pair = (a: string[], b: string[]) => {
        const h = Math.max(a.length, b.length);
        const grow = (x: string[]) => {
          while (x.length < h) x.splice(x.length - 1, 0, box([""], { width: colW })[1]!);
          return x;
        };
        grow(a);
        grow(b);
        for (let i = 0; i < h; i++) out.push(" " + a[i] + " " + b[i]);
      };
      pair(this.cpuPanel(colW), this.memPanel(colW));
      pair(this.netPanel(colW), this.diskPanel(colW));
    } else {
      const w = W - 2;
      for (const p of [this.cpuPanel(w), this.memPanel(w), this.netPanel(w), this.diskPanel(w)]) out.push(...p.map((l) => " " + l));
    }
    const left = H - out.length;
    if (left >= 5) out.push(...this.procTable(W - 2, left, false).map((l) => " " + l));
    return out;
  }

  private processView(W: number, H: number): string[] {
    return this.procTable(W - 2, H, true).map((l) => " " + l);
  }

  // ── Input ────────────────────────────────────────────────────────────────────
  /** Returns "quit" when the user wants out. */
  key(k: Key, pageSize: number): "quit" | void {
    if (this.confirm) {
      const target = this.confirm;
      this.confirm = null;
      const ch = k.text?.toLowerCase();
      if (ch === "y" || ch === "c") void this.kill(target);
      return;
    }
    if (this.filtering) {
      if (isEscape(k)) {
        this.filter = "";
        this.filtering = false;
      } else if (isEnter(k)) this.filtering = false;
      else if (k.name === "backspace") this.filter = this.filter.slice(0, -1);
      else if (k.text) this.filter += k.text;
      this.selected = 0;
      return;
    }
    if (isCtrlC(k) || isEscape(k) || k.name === "q") return "quit";
    const name = k.name;
    if (name === "tab" || name === "right" || name === "left") this.view = this.view === "overview" ? "processes" : "overview";
    else if (k.text === "1") this.view = "overview";
    else if (k.text === "2") this.view = "processes";
    else if (name === "s") {
      const order: Sort[] = ["cpu", "mem", "name"];
      this.sort = order[(order.indexOf(this.sort) + 1) % order.length]!;
    } else if (name === "g") this.group = !this.group;
    else if (name === "p") this.paused = !this.paused;
    else if (name === "r") this.refresh();
    else if (k.text === "/") {
      this.view = "processes";
      this.filtering = true;
    } else if (name === "up" || name === "down" || name === "pageup" || name === "pagedown" || name === "home" || name === "end") {
      this.view = "processes";
      const n = this.rows().length;
      const delta = name === "up" ? -1 : name === "down" ? 1 : name === "pageup" ? -pageSize : name === "pagedown" ? pageSize : 0;
      if (name === "home") this.selected = 0;
      else if (name === "end") this.selected = Math.max(0, n - 1);
      else this.selected = Math.max(0, Math.min(n - 1, this.selected + delta));
    } else if ((name === "k" || name === "delete" || name === "x") && this.view === "processes") {
      const row = this.rows()[this.selected];
      if (row) this.confirm = row;
    }
  }

  private async kill(row: Row): Promise<void> {
    let ok = 0;
    let denied = 0;
    for (const pid of row.pids) {
      if (pid === process.pid || pid === pwsh.pid) continue;
      const r = await killProcess(pid);
      if (r === "killed" || r === "gone") ok++;
      else denied++;
    }
    this.flash = denied
      ? { text: t("dash.killDenied", { name: row.name }), until: Date.now() + 4000, ok: false }
      : { text: t("dash.killed", { name: row.name, n: ok }), until: Date.now() + 3000, ok: true };
    this.refresh();
  }
}

export async function dashCommand(opts: DashOptions, ctx: Ctx): Promise<void> {
  const dash = new Dashboard(opts.view ?? "overview");

  if (opts.once || !isInteractive()) {
    // One static frame: take two samples a second apart so rates and CPU are real.
    await Promise.all([memory().then((m) => (dash.mem = m)), disks().then((d) => (dash.disks = d)).catch(() => {}), battery().then((b) => (dash.battery = b)).catch(() => {})]);
    const cpu = new CpuSampler();
    const net = new NetworkSampler();
    const procs = new ProcessSampler();
    await Promise.all([net.sample().catch(() => null), procs.sample().catch(() => [])]);
    await new Promise((r) => setTimeout(r, 1000));
    dash.cpu = cpu.sample();
    dash.cpuHist = [dash.cpu.total];
    const [n, p] = await Promise.all([net.sample().catch(() => null), procs.sample().catch(() => [])]);
    if (n) dash.net = n;
    dash.procs = p;
    if (dash.mem) dash.memHist = [dash.mem.pct];
    print(...dash.render(columns(), 40, false), "");
    return;
  }

  const screen = new FullScreen(() => draw());
  let scheduled = false;
  const draw = () => screen.draw(dash.render(screen.cols, screen.rows));
  const requestDraw = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      draw();
    }, 16);
  };

  await new Promise<void>((resolve) => {
    screen.enter();
    const clock = setInterval(requestDraw, 1000);
    const finish = () => {
      clearInterval(clock);
      dash.stop();
      release();
      screen.exit();
      resolve();
    };
    const release = pushKeys((k) => {
      if (dash.key(k, Math.max(1, screen.rows - 8)) === "quit") finish();
      else requestDraw();
    });
    ctx.signal.addEventListener("abort", finish, { once: true });
    dash.startPolling(requestDraw);
    draw();
  });
}
