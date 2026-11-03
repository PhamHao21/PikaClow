import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not be started at all (e.g. not installed). */
  error?: Error;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  input?: string;
  signal?: AbortSignal;
  maxBuffer?: number;
}

const whichCache = new Map<string, string | null>();

/** Finds an executable on PATH (honors PATHEXT on Windows). Cached. */
export function which(cmd: string): string | null {
  if (whichCache.has(cmd)) return whichCache.get(cmd)!;
  let found: string | null = null;
  const exts = isWindows ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const candidates = (dir: string) =>
    isWindows && extname(cmd) === "" ? exts.map((e) => join(dir, cmd + e.toLowerCase())) : [join(dir, cmd)];
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(cmd)) found = existsSync(cmd) ? cmd : null;
  else {
    for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
      if (!dir) continue;
      const hit = candidates(dir.replace(/^"|"$/g, "")).find(isFile);
      if (hit) {
        found = hit;
        break;
      }
    }
  }
  whichCache.set(cmd, found);
  return found;
}

// cmd.exe quoting for the few args we pass to .cmd/.bat shims (npm, pnpm, yarn…).
function quoteForCmd(arg: string): string {
  if (/^[\w./:=@-]+$/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

/**
 * Runs a program without a shell and collects its output. Never throws:
 * failures are reported through `code`, `error` and `timedOut`.
 */
export function run(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const timeout = opts.timeout ?? 15000;
    const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
    let file = cmd;
    let spawnArgs = args;
    let shell = false;
    if (isWindows) {
      const resolved = which(cmd);
      // Since Node 18.20/20.12, .cmd/.bat files can only be started through a shell.
      if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
        shell = true;
        file = `"${resolved}"`;
        spawnArgs = args.map(quoteForCmd);
      } else if (resolved) {
        file = resolved;
      }
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, spawnArgs, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell,
        windowsHide: true,
        signal: opts.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: error as Error });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (stdout.length < maxBuffer) stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      if (stderr.length < maxBuffer) stderr += d;
    });
    child.on("error", (error) => done({ code: null, stdout, stderr, timedOut, error }));
    child.on("close", (code) => done({ code, stdout, stderr, timedOut }));
    child.stdin?.on("error", () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Runs and returns trimmed stdout, or null on any failure. */
export async function capture(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<string | null> {
  const r = await run(cmd, args, opts);
  if (r.error || r.timedOut || r.code !== 0) return null;
  return r.stdout.trim();
}
