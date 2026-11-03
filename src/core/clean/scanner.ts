import { promises as fs, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { matchRule, SKIP_DIRS, type CleanRule } from "./rules.js";
import { run, which } from "../exec.js";

export interface JunkItem {
  path: string;
  name: string;
  project: string;
  rule: CleanRule;
  size: number;
  files: number;
  /** Newest modification time found in the project root (ms since epoch). */
  lastTouched: number;
  /** For "verify" rules: true when git confirms the folder is ignored. */
  gitIgnored: boolean | null;
  /** Stopped counting because the folder is enormous; size is a lower bound. */
  partial: boolean;
}

export interface ScanProgress {
  dirs: number;
  found: number;
  current: string;
}

/** Tiny semaphore to cap concurrent filesystem calls. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
}

/**
 * Walks `root` looking for regenerable folders. Async and bounded, so the terminal
 * stays responsive; hidden folders, symlinks and system/app-data folders are skipped.
 */
export async function findJunk(
  root: string,
  opts: { maxDepth?: number; signal?: AbortSignal; onProgress?: (p: ScanProgress) => void } = {},
): Promise<Omit<JunkItem, "size" | "files" | "lastTouched" | "gitIgnored" | "partial">[]> {
  const maxDepth = opts.maxDepth ?? 8;
  const found: Omit<JunkItem, "size" | "files" | "lastTouched" | "gitIgnored" | "partial">[] = [];
  const progress: ScanProgress = { dirs: 0, found: 0, current: root };
  const limit = limiter(16);
  let lastReport = 0;

  const visit = async (dir: string, depth: number): Promise<void> => {
    aborted(opts.signal);
    let entries: Dirent[];
    try {
      entries = await limit(() => fs.readdir(dir, { withFileTypes: true }));
    } catch {
      return;
    }
    progress.dirs++;
    progress.current = dir;
    const now = Date.now();
    if (opts.onProgress && now - lastReport > 80) {
      lastReport = now;
      opts.onProgress({ ...progress });
    }
    const names = entries.map((e) => e.name);
    const siblings = new Set(names);
    const children: Promise<void>[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const rule = matchRule(e.name, siblings, names);
      if (rule) {
        found.push({ path: join(dir, e.name), name: e.name, project: dir, rule });
        progress.found = found.length;
        continue;
      }
      const lower = e.name.toLowerCase();
      if (e.name.startsWith(".") || e.name.startsWith("$") || SKIP_DIRS.has(lower)) continue;
      if (depth + 1 > maxDepth) continue;
      children.push(visit(join(dir, e.name), depth + 1));
    }
    await Promise.all(children);
  };

  await visit(root, 0);
  opts.onProgress?.({ ...progress });
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

const MAX_ENTRIES = 400_000;

/** Total size of a folder tree (symlinks not followed). */
export async function folderSize(
  path: string,
  opts: { signal?: AbortSignal; onBytes?: (delta: number) => void } = {},
): Promise<{ bytes: number; files: number; partial: boolean }> {
  const limit = limiter(24);
  let bytes = 0;
  let files = 0;
  let partial = false;
  const walk = async (dir: string): Promise<void> => {
    aborted(opts.signal);
    if (files > MAX_ENTRIES) {
      partial = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await limit(() => fs.readdir(dir, { withFileTypes: true }));
    } catch {
      return;
    }
    const subdirs: Promise<void>[] = [];
    const stats: Promise<void>[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) subdirs.push(walk(full));
      else if (e.isFile()) {
        files++;
        stats.push(
          limit(() => fs.lstat(full)).then(
            (st) => {
              bytes += st.size;
              opts.onBytes?.(st.size);
            },
            () => {},
          ),
        );
      }
    }
    await Promise.all([...stats, ...subdirs]);
  };
  await walk(path);
  return { bytes, files, partial };
}

/** Newest mtime among the files directly inside a project folder. */
export async function lastTouched(project: string): Promise<number> {
  let newest = 0;
  try {
    const entries = await fs.readdir(project, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).slice(0, 60);
    const stats = await Promise.all(files.map((f) => fs.lstat(join(project, f.name)).catch(() => null)));
    for (const s of stats) if (s && s.mtimeMs > newest) newest = s.mtimeMs;
    if (newest === 0) newest = (await fs.lstat(project)).mtimeMs;
  } catch {
    // unreadable: treat as unknown (0)
  }
  return newest;
}

/** Asks git which of the given folders (same parent) are ignored. null = not a git repo / no git. */
export async function gitIgnored(project: string, names: string[]): Promise<Map<string, boolean> | null> {
  if (!which("git")) return null;
  const r = await run("git", ["-C", project, "check-ignore", "--", ...names], { timeout: 5000 });
  if (r.error || r.timedOut || (r.code !== 0 && r.code !== 1)) return null;
  const ignored = new Set(r.stdout.split(/\r?\n/).map((s) => basename(s.trim().replace(/[\\/]+$/, ""))).filter(Boolean));
  return new Map(names.map((n) => [n, ignored.has(n)]));
}

/** Deletes a folder tree. Returns bytes freed (the measured size) or throws. */
export async function removeFolder(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
}

