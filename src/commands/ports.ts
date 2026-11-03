import os from "node:os";
import { canBind, findFreePort, killProcess, listPorts, type PortEntry } from "../core/ports.js";
import { tildify, tildifyText } from "../core/format.js";
import type { Ctx } from "../core/context.js";
import { t } from "../i18n/index.js";
import { box, titleBlock, status, table, cmd } from "../ui/components.js";
import { blank, print, printJson } from "../ui/print.js";
import { confirm, isCancel, select } from "../ui/prompts.js";
import { spinner } from "../ui/spinner.js";
import { columns, isInteractive } from "../ui/terminal.js";
import { c, P } from "../ui/theme.js";
import { truncate } from "../ui/text.js";

export interface PortsOptions {
  all?: boolean;
  udp?: boolean;
  json?: boolean;
  kill?: boolean;
  yes?: boolean;
  pick?: boolean;
}

function parsePorts(arg: string | undefined): number[] | null {
  if (!arg) return null;
  const ports = arg
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => Number(s.replace(/^:/, "")));
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error(t("ports.badPort", { value: arg }));
  return ports;
}

const home = os.homedir();

function scopeLabel(e: PortEntry): string {
  return e.scope === "local" ? c.ok(t("ports.scopeLocal")) : c.warn(t("ports.scopeNetwork"));
}

function describe(e: PortEntry): string {
  if (e.project) return tildify(e.project, home);
  return e.command ? tildifyText(e.command, home).replace(/^"[^"]*[\\/]([^\\/"]+)"/, "$1") : "";
}

function detailCard(e: PortEntry): string[] {
  const w = Math.min(columns() - 2, 96);
  const lines = [
    c.muted(t("ports.process").padEnd(10)) + c.bold(e.process) + c.faint(`  PID ${e.pid}`) + (e.system ? "  " + c.warn(t("ports.systemTag")) : ""),
  ];
  if (e.app) lines.push(c.muted(t("ports.app").padEnd(10)) + c.brand(e.app));
  if (e.project) lines.push(c.muted(t("ports.project").padEnd(10)) + tildify(e.project, home));
  lines.push(c.muted(t("ports.listen").padEnd(10)) + e.addresses.join(", ") + "  " + scopeLabel(e));
  if (e.command) lines.push(c.muted(t("ports.command").padEnd(10)) + c.faint(truncate(tildifyText(e.command, home), w - 16)));
  return box(lines, { title: `${e.protocol.toUpperCase()} :${e.port}`, width: w });
}

async function killEntries(entries: PortEntry[], opts: PortsOptions, ctx: Ctx): Promise<void> {
  const targets = new Map<number, PortEntry>();
  for (const e of entries) targets.set(e.pid, e);
  for (const e of targets.values()) {
    if (e.pid <= 4) {
      print(status.fail(t("ports.cannotKillSystem", { name: e.process })));
      continue;
    }
    if (!opts.yes) {
      if (!isInteractive()) {
        print(status.warn(t("ports.needYes")));
        return;
      }
      const ok = await confirm({
        message: t("ports.confirmKill", { name: e.process, pid: e.pid, port: e.port }),
        danger: e.system,
        signal: ctx.signal,
      });
      if (isCancel(ok) || !ok) {
        print(status.hint(t("ports.killSkipped")));
        continue;
      }
    }
    const r = await killProcess(e.pid);
    if (r === "killed" || r === "gone") {
      // Give the OS a moment to release the socket, then verify.
      await new Promise((res) => setTimeout(res, 400));
      const free = await canBind(e.port);
      print(free ? status.ok(t("ports.killed", { name: e.process, pid: e.pid, port: e.port })) : status.warn(t("ports.killedButBusy", { port: e.port })));
    } else if (r === "denied") {
      print(status.fail(t("ports.denied", { name: e.process, pid: e.pid })));
    } else {
      print(status.fail(t("ports.killFailed", { pid: e.pid })));
    }
  }
}

export async function portsCommand(portArg: string | undefined, opts: PortsOptions, ctx: Ctx): Promise<void> {
  const wanted = parsePorts(portArg);
  const spin = opts.json ? null : spinner(t("ports.scanning"));
  let entries: PortEntry[];
  try {
    entries = await listPorts({ udp: Boolean(opts.udp) });
  } finally {
    spin?.stop();
  }

  if (wanted) {
    const hits = entries.filter((e) => wanted.includes(e.port));
    if (opts.json) return printJson(hits);
    blank();
    print(...titleBlock("PORTS", wanted.map((p) => ":" + p).join("  ")));
    blank();
    for (const port of wanted) {
      const mine = hits.filter((e) => e.port === port);
      if (mine.length === 0) {
        const free = await canBind(port);
        print(free ? status.ok(t("ports.free", { port })) : status.warn(t("ports.busyUnknown", { port })));
        continue;
      }
      for (const e of mine) print(...detailCard(e));
      if (!opts.kill && mine.some((e) => !e.system)) {
        const taken = new Set(entries.map((e) => e.port));
        const next = await findFreePort(port + 1, taken);
        print(status.hint(t("ports.killHint", { cmd: cmd(`pikaclow ports ${port} --kill`) })));
        if (next) print(status.hint(t("ports.nextFree", { port: c.brand(String(next)) })));
      }
    }
    if (opts.kill && hits.length) {
      blank();
      await killEntries(hits, opts, ctx);
    }
    blank();
    return;
  }

  const shown = opts.all ? entries : entries.filter((e) => !e.system);
  const hidden = entries.length - shown.length;
  if (opts.json) return printJson(shown);

  blank();
  print(...titleBlock("PORTS", t("ports.subtitle", { count: shown.length })));
  blank();
  if (shown.length === 0) {
    print(status.ok(t("ports.none")));
  } else {
    const w = columns() - 2;
    const rows = shown.map((e) => [
      e.port < 1024 ? c.amber(String(e.port)) : c.brandBold(String(e.port)),
      (opts.udp ? e.protocol.toUpperCase() + " " : "") + (e.system ? c.faint(e.process) : e.process),
      c.faint(String(e.pid)),
      e.app ? c.soft(e.app) : c.faint("–"),
      e.scope === "local" ? c.tile(t("ports.scopeLocalShort").toUpperCase(), P.ok) : c.tile(t("ports.scopeNetworkShort").toUpperCase(), P.warn),
      c.muted(describe(e)),
    ]);
    const lines = table(
      [
        { header: t("ports.colPort"), align: "right", min: 5 },
        { header: t("ports.colProcess"), min: 8, grow: true },
        { header: "PID", align: "right" },
        { header: t("ports.colApp"), min: 6, grow: true },
        { header: t("ports.colScope") },
        { header: t("ports.colWhere"), min: 10, grow: true },
      ],
      rows,
      w,
    );
    print(...lines.map((l) => " " + l));
  }
  blank();
  const notes = [t("ports.footerKill", { cmd: cmd("pikaclow ports <port> --kill") })];
  if (hidden > 0) notes.unshift(t("ports.footerHidden", { count: hidden, flag: cmd("--all") }));
  print(" " + c.faint(notes.join("  ·  ")));
  if (shown.some((e) => e.scope === "network" && !e.system && e.app)) print(" " + c.faint(t("ports.networkNote")));
  blank();

  if (opts.pick && shown.length && isInteractive()) {
    const choice = await select({
      message: t("ports.pickKill"),
      options: [
        ...shown.filter((e) => !e.system).map((e) => ({ value: e.port, label: `:${e.port}  ${e.process}`, hint: [e.app, describe(e)].filter(Boolean).join(" · ") })),
        { value: -1, label: t("prompt.nothing") },
      ],
      signal: ctx.signal,
    });
    if (!isCancel(choice) && choice > 0) await killEntries(shown.filter((e) => e.port === choice), { ...opts, yes: false }, ctx);
  }
}
