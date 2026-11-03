import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { capture, isLinux, isWindows, run, which } from "./exec.js";
import { pwsh } from "./win/pwsh.js";

export interface PortEntry {
  port: number;
  protocol: "tcp" | "udp";
  /** Bind addresses, e.g. ["0.0.0.0", "::"]. */
  addresses: string[];
  pid: number;
  process: string;
  command: string;
  /** Who can reach it: only this machine, or the network. */
  scope: "local" | "network";
  /** Belongs to the operating system rather than something the user started. */
  system: boolean;
  /** Detected app, e.g. "Vite", "PostgreSQL". */
  app: string;
  /** Project folder guessed from the command line. */
  project: string;
}

interface RawSocket {
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  pid: number;
  process?: string;
}

// ── Parsers (exported for tests) ───────────────────────────────────────────────
function splitHostPort(s: string): { host: string; port: number } | null {
  const m = /^(.*):(\d+)$/.exec(s);
  if (!m) return null;
  let host = m[1] ?? "";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/%.*$/, "");
  return { host: host === "*" ? "0.0.0.0" : host, port: Number(m[2]) };
}

/**
 * Parses `netstat -ano`. A TCP socket is listening when its foreign address is
 * 0.0.0.0:0 or [::]:0, which works on every Windows display language
 * (the "LISTENING" word itself is translated).
 */
export function parseNetstat(text: string, includeUdp = false): RawSocket[] {
  const out: RawSocket[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    const proto = parts[0]?.toUpperCase();
    if (proto === "TCP" || proto === "TCPV6") {
      if (parts.length < 5) continue;
      const foreign = parts[2] ?? "";
      if (!/^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign) && !/^\*:\*$/.test(foreign)) continue;
      const local = splitHostPort(parts[1] ?? "");
      const pid = Number(parts[parts.length - 1]);
      if (local && local.port > 0 && Number.isFinite(pid)) out.push({ protocol: "tcp", address: local.host, port: local.port, pid });
    } else if (includeUdp && (proto === "UDP" || proto === "UDPV6")) {
      const local = splitHostPort(parts[1] ?? "");
      const pid = Number(parts[parts.length - 1]);
      if (local && local.port > 0 && Number.isFinite(pid)) out.push({ protocol: "udp", address: local.host, port: local.port, pid });
    }
  }
  return out;
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -FpcnP` (macOS and Linux). */
export function parseLsof(text: string): RawSocket[] {
  const out: RawSocket[] = [];
  let pid = 0;
  let cmd = "";
  let proto: "tcp" | "udp" = "tcp";
  for (const line of text.split(/\r?\n/)) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") pid = Number(val);
    else if (tag === "c") cmd = val;
    else if (tag === "P") proto = val.toLowerCase() === "udp" ? "udp" : "tcp";
    else if (tag === "n") {
      const hp = splitHostPort(val.replace(/->.*$/, ""));
      if (hp && hp.port > 0) out.push({ protocol: proto, address: hp.host, port: hp.port, pid, process: cmd });
    }
  }
  return out;
}

/** Parses `ss -ltnpH` (Linux). */
export function parseSs(text: string): RawSocket[] {
  const out: RawSocket[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = splitHostPort(parts[3] ?? "");
    if (!local || local.port <= 0) continue;
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    out.push({ protocol: "tcp", address: local.host, port: local.port, pid: users ? Number(users[2]) : 0, process: users?.[1] ?? "" });
  }
  return out;
}

// Kernel order: each 32-bit word of the address is little-endian hex.
function procNetAddress(hex: string): string {
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((w) => (w.match(/../g) ?? []).reverse().map((b) => parseInt(b, 16)));
  if (bytes.length === 4) return bytes.join(".");
  const groups: string[] = [];
  for (let i = 0; i < bytes.length; i += 2) groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  // The URL parser prints IPv6 in canonical compressed form ("::1", "::").
  return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
}

/** Parses `/proc/net/tcp` or `/proc/net/tcp6` (Linux without lsof/ss). `pid` is the socket inode here. */
export function parseProcNet(text: string): RawSocket[] {
  const out: RawSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[3] !== "0A") continue; // 0A = TCP_LISTEN
    const [addr, portHex] = (f[1] ?? "").split(":");
    if (!addr || !portHex) continue;
    out.push({ protocol: "tcp", address: procNetAddress(addr), port: parseInt(portHex, 16), pid: Number(f[9] ?? 0) });
  }
  return out;
}

/** Maps socket inodes to the pid that owns them, by walking `/proc/<pid>/fd`. */
function procSocketOwners(inodes: Set<number>): Map<number, { pid: number; name: string }> {
  const owners = new Map<number, { pid: number; name: string }>();
  for (const dir of readdirSync("/proc")) {
    if (!PID_RE.test(dir)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${dir}/fd`);
    } catch {
      continue; // another user's process
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(`/proc/${dir}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = Number(/^socket:\[(\d+)\]$/.exec(link)?.[1] ?? 0);
      if (!inodes.has(inode) || owners.has(inode)) continue;
      let name = "";
      try {
        name = readFileSync(`/proc/${dir}/comm`, "utf8").trim();
      } catch {}
      owners.set(inode, { pid: Number(dir), name });
    }
    if (owners.size === inodes.size) break;
  }
  return owners;
}

function procSockets(): RawSocket[] {
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const sockets = [...parseProcNet(read("/proc/net/tcp")), ...parseProcNet(read("/proc/net/tcp6"))];
  const owners = procSocketOwners(new Set(sockets.map((s) => s.pid)));
  return sockets.map((s) => {
    const o = owners.get(s.pid);
    return { ...s, pid: o?.pid ?? 0, process: o?.name ?? "" };
  });
}

// ── Classification ─────────────────────────────────────────────────────────────
const SYSTEM_PROCS = new Set(
  [
    "system", "idle", "svchost", "lsass", "wininit", "services", "spoolsv", "smss", "csrss", "winlogon",
    "registry", "memory compression", "secure system", "jhi_service", "msmpeng", "nissrv", "searchindexer",
    "launchd", "mdnsresponder", "rapportd", "controlcenter", "sharingd", "identityservicesd", "remoted",
    "systemd", "systemd-resolve", "systemd-resolved", "cupsd", "avahi-daemon", "chronyd", "rpcbind", "dnsmasq",
    "systemd-network", "systemd-networkd",
  ].map((s) => s.toLowerCase()),
);

export function isSystemProcess(pid: number, name: string): boolean {
  if (pid <= 4) return true;
  return SYSTEM_PROCS.has(name.toLowerCase().replace(/\.exe$/, ""));
}

const APP_BY_COMMAND: [RegExp, string][] = [
  [/[\\/]vite[\\/]bin|\bvite(\.js)?\b/i, "Vite"],
  [/[\\/]next[\\/]dist|\bnext(\.js)?\s+(dev|start)/i, "Next.js"],
  [/\bnuxi?\b/i, "Nuxt"],
  [/\bastro\b/i, "Astro"],
  [/react-scripts/i, "Create React App"],
  [/webpack-dev-server|webpack(\.js)?\s+serve/i, "webpack dev server"],
  [/@angular[\\/]cli|\bng(\.js)?\s+serve/i, "Angular"],
  [/@remix-run|\bremix\b/i, "Remix"],
  [/svelte-kit|@sveltejs/i, "SvelteKit"],
  [/\bparcel\b/i, "Parcel"],
  [/storybook/i, "Storybook"],
  [/@expo|\bexpo\b/i, "Expo"],
  [/@nestjs|\bnest(\.js)?\s+start/i, "NestJS"],
  [/nodemon/i, "nodemon"],
  [/json-server/i, "json-server"],
  [/http-server|live-server|[\\/]serve[\\/]build/i, "Static file server"],
  [/manage\.py\s+runserver/i, "Django"],
  [/\bflask\b/i, "Flask"],
  [/uvicorn|gunicorn|hypercorn/i, "Python web server"],
  [/-m\s+http\.server/i, "Python http.server"],
  [/jupyter/i, "Jupyter"],
  [/artisan\s+serve/i, "Laravel"],
  [/\brails\s+s|puma/i, "Rails"],
  [/spring-boot|\bspring\b/i, "Spring Boot"],
  [/dotnet(\.exe)?\s+(run|watch)/i, ".NET"],
  [/\bhugo\b/i, "Hugo"],
  [/ollama/i, "Ollama"],
];

const APP_BY_PROCESS: Record<string, string> = {
  postgres: "PostgreSQL", mysqld: "MySQL", mariadbd: "MariaDB", mongod: "MongoDB", "redis-server": "Redis",
  nginx: "nginx", httpd: "Apache", "com.docker.backend": "Docker", "docker-proxy": "Docker", vpnkit: "Docker",
  wslrelay: "WSL", ollama: "Ollama", "ollama app": "Ollama", code: "VS Code", "code - insiders": "VS Code",
  idea64: "IntelliJ IDEA", "sqlservr": "SQL Server", "rabbitmq-server": "RabbitMQ", erl: "Erlang/RabbitMQ",
  elasticsearch: "Elasticsearch", "lm studio": "LM Studio", memurai: "Redis (Memurai)", xampp: "XAMPP",
  "sshd": "SSH server", "lsass": "Windows auth (RPC)", "svchost": "Windows service", system: "Windows kernel",
};

const WELL_KNOWN: Record<number, string> = {
  20: "FTP data", 21: "FTP", 22: "SSH", 25: "SMTP", 53: "DNS", 80: "HTTP", 110: "POP3", 135: "Windows RPC",
  139: "NetBIOS", 143: "IMAP", 443: "HTTPS", 445: "SMB file sharing", 587: "SMTP", 1433: "SQL Server",
  1521: "Oracle", 2375: "Docker API", 3000: "Dev server", 3306: "MySQL", 3389: "Remote Desktop", 4200: "Angular",
  5000: "Dev server", 5040: "Windows CDP", 5173: "Vite", 5357: "Windows WSD", 5432: "PostgreSQL", 5672: "RabbitMQ",
  6379: "Redis", 7680: "Windows Update (DO)", 8000: "Dev server", 8080: "HTTP alt", 8443: "HTTPS alt",
  9000: "Dev server", 9200: "Elasticsearch", 11434: "Ollama", 27017: "MongoDB",
};

export function detectApp(processName: string, command: string, port: number): string {
  for (const [re, label] of APP_BY_COMMAND) if (re.test(command)) return label;
  const base = processName.toLowerCase().replace(/\.exe$/, "");
  if (APP_BY_PROCESS[base]) return APP_BY_PROCESS[base]!;
  if (/^(node|bun|deno)$/.test(base)) return "Node.js app";
  if (/^python\d*(\.\d+)?$/.test(base)) return "Python app";
  if (/^java$/.test(base)) return "Java app";
  if (/^php/.test(base)) return "PHP";
  return WELL_KNOWN[port] ?? "";
}

/** Guesses the project folder from a command line (paths before node_modules, or the script's folder). */
export function detectProject(command: string): string {
  const paths = command.match(/[A-Za-z]:\\[^"*?<>|\r\n]+?(?=\s+-|\s*"|\s*$|\s+[A-Za-z]:\\)|\/(?:[^\s"']+\/)+[^\s"']*/g) ?? [];
  for (const p of paths) {
    const nm = p.search(/[\\/]node_modules[\\/]/i);
    if (nm > 0) return p.slice(0, nm);
  }
  for (const p of paths) {
    if (/\.(m?js|cjs|ts|py|rb|php|jar)$/i.test(p.trim()) && !/[\\/](Program Files|AppData|usr[\\/]lib|usr[\\/]local[\\/]lib)[\\/]/i.test(p)) {
      const file = p.trim();
      // Pick the path flavour from the path itself, not from the OS we run on.
      return /^[A-Za-z]:\\/.test(file) ? path.win32.dirname(file) : path.posix.dirname(file);
    }
  }
  return "";
}

function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("127.") || addr === "localhost";
}

// ── Collection ─────────────────────────────────────────────────────────────────
interface ProcDetails {
  name: string;
  command: string;
}

const PID_RE = /^\d+$/;

async function windowsProcDetails(pids: number[]): Promise<Map<number, ProcDetails>> {
  const map = new Map<number, ProcDetails>();
  const ids = pids.filter((p) => PID_RE.test(String(p)) && p > 0);
  if (ids.length === 0) return map;
  // Numbers only are interpolated here; never user text.
  const filter = ids.map((p) => `ProcessId=${p}`).join(" OR ");
  const script = `$o = foreach($p in Get-CimInstance Win32_Process -Filter "${filter}"){ "$($p.ProcessId)\`t$($p.Name)\`t$($p.CommandLine)" }; [Console]::Out.Write($o -join "\`n")`;
  try {
    const out = await pwsh.run(script, 10000);
    for (const line of out.split("\n")) {
      const [pid, name, ...rest] = line.split("\t");
      if (pid) map.set(Number(pid), { name: name ?? "", command: rest.join("\t").trim() });
    }
  } catch {
    // Names are optional; fall back to tasklist below.
  }
  const missing = ids.filter((p) => !map.get(p)?.name);
  if (missing.length) {
    const r = await run("tasklist", ["/FO", "CSV", "/NH"], { timeout: 8000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(line);
      if (m && missing.includes(Number(m[2]))) map.set(Number(m[2]), { name: m[1] ?? "", command: "" });
    }
  }
  return map;
}

async function unixCommands(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const ids = pids.filter((p) => p > 0);
  if (!ids.length) return map;
  if (isLinux) {
    // Straight from /proc: works even where ps is not installed (slim containers).
    for (const pid of ids) {
      try {
        map.set(pid, readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "));
      } catch {}
    }
    return map;
  }
  const out = await capture("ps", ["-o", "pid=,args=", "-p", ids.join(",")], { timeout: 5000 });
  for (const line of (out ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) map.set(Number(m[1]), m[2] ?? "");
  }
  return map;
}

async function rawSockets(includeUdp: boolean): Promise<RawSocket[]> {
  if (isWindows) {
    const r = await run("netstat", ["-ano"], { timeout: 10000 });
    if (r.error || r.timedOut) throw new Error("netstat failed");
    return parseNetstat(r.stdout, includeUdp);
  }
  if (which("lsof")) {
    const args = ["-nP", "-FpcnP", "-iTCP", "-sTCP:LISTEN"];
    const r = await run("lsof", args, { timeout: 10000 });
    const tcp = parseLsof(r.stdout);
    if (!includeUdp) return tcp;
    const u = await run("lsof", ["-nP", "-FpcnP", "-iUDP"], { timeout: 10000 });
    return [...tcp, ...parseLsof(u.stdout)];
  }
  if (isLinux && which("ss")) {
    const r = await run("ss", ["-ltnpH"], { timeout: 10000 });
    return parseSs(r.stdout);
  }
  if (isLinux) return procSockets();
  throw new Error("Neither lsof nor ss is available");
}

/** Lists listening ports with the owning process, merged per (port, pid, protocol). */
export async function listPorts(opts: { udp?: boolean } = {}): Promise<PortEntry[]> {
  const sockets = await rawSockets(Boolean(opts.udp));
  const pids = [...new Set(sockets.map((s) => s.pid))];
  let details = new Map<number, ProcDetails>();
  if (isWindows) details = await windowsProcDetails(pids);
  else {
    const cmds = await unixCommands(pids);
    for (const s of sockets) details.set(s.pid, { name: s.process ?? "", command: cmds.get(s.pid) ?? "" });
  }
  const merged = new Map<string, PortEntry>();
  for (const s of sockets) {
    const key = `${s.protocol}:${s.port}:${s.pid}`;
    const d = details.get(s.pid);
    const name = d?.name || s.process || (s.pid === 4 ? "System" : "?");
    let e = merged.get(key);
    if (!e) {
      const command = d?.command ?? "";
      e = {
        port: s.port,
        protocol: s.protocol,
        addresses: [],
        pid: s.pid,
        process: name,
        command,
        scope: "local",
        system: isSystemProcess(s.pid, name),
        app: detectApp(name, command, s.port),
        project: detectProject(command),
      };
      merged.set(key, e);
    }
    if (!e.addresses.includes(s.address)) e.addresses.push(s.address);
    if (!isLoopback(s.address)) e.scope = "network";
  }
  return [...merged.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** Tries to bind the port on all interfaces; true when nothing else holds it. */
export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** Next free port at or after `start`. */
export async function findFreePort(start: number, taken: Set<number>): Promise<number | null> {
  for (let p = start; p < Math.min(65535, start + 200); p++) {
    if (taken.has(p)) continue;
    if (await canBind(p)) return p;
  }
  return null;
}

export type KillResult = "killed" | "denied" | "gone" | "failed";

/** Ends a process. On Windows this is a hard stop (TerminateProcess), like Task Manager. */
export async function killProcess(pid: number): Promise<KillResult> {
  if (pid <= 4 || pid === process.pid) return "denied";
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "denied";
    return "failed";
  }
  if (isWindows) return "killed";
  // Give Unix processes a moment to exit cleanly, then insist.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return "killed";
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // exited in between
  }
  return "killed";
}
