import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { run, which } from "./exec.js";

/** Walks up from `start` to the folder containing .git. */
export function findRepoRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Current branch, read straight from .git/HEAD (no git process). */
export function currentBranch(root: string): string | null {
  try {
    let gitDir = join(root, ".git");
    if (statSync(gitDir).isFile()) {
      // Worktrees and submodules: ".git" is a file pointing at the real git dir.
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m?.[1]) return null;
      gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(root, m[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref?.[1]) return ref[1];
    return head.slice(0, 7);
  } catch {
    return null;
  }
}

export const hasGit = () => Boolean(which("git"));

async function git(args: string[], cwd: string, timeout = 15000) {
  return run("git", args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
}

export interface FileChange {
  status: string;
  path: string;
}

export async function stagedChanges(cwd: string): Promise<FileChange[]> {
  const r = await git(["diff", "--cached", "--name-status", "-z", "--no-renames"], cwd);
  const parts = r.stdout.split("\0").filter(Boolean);
  const out: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i]!, path: parts[i + 1]! });
  return out;
}

/** Unstaged + untracked files (porcelain). */
export async function pendingChanges(cwd: string): Promise<FileChange[]> {
  const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }))
    .filter((e) => e.status[1] !== " " || e.status === "??");
}

// Lockfiles and generated/binary files carry no meaning for a commit message.
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(min\.(js|css)|map|snap|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz|lock)$/i;

/** The staged diff, trimmed to a budget so small local models can handle it. */
export async function stagedDiff(cwd: string, budget = 12000): Promise<{ diff: string; stat: string; truncated: boolean }> {
  const stat = (await git(["diff", "--cached", "--stat=100", "--no-color"], cwd)).stdout.trim();
  const files = (await stagedChanges(cwd)).map((f) => f.path).filter((p) => !NOISE.test(p));
  if (files.length === 0) return { diff: "", stat, truncated: false };
  const r = await git(["diff", "--cached", "--no-color", "--no-ext-diff", "-U2", "--", ...files], cwd);
  let diff = r.stdout;
  let truncated = false;
  if (diff.length > budget) {
    // Keep every file header and the start of each hunk rather than only the first files.
    const chunks = diff.split(/(?=^diff --git )/m);
    const per = Math.max(400, Math.floor(budget / Math.max(1, chunks.length)));
    diff = chunks.map((ch) => (ch.length > per ? ch.slice(0, per) + "\n… (truncated)\n" : ch)).join("");
    if (diff.length > budget) diff = diff.slice(0, budget) + "\n… (truncated)\n";
    truncated = true;
  }
  return { diff, stat, truncated };
}

export async function recentSubjects(cwd: string, n = 12): Promise<string[]> {
  const r = await git(["log", `-n${n}`, "--pretty=%s", "--no-merges"], cwd);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export async function stageAll(cwd: string): Promise<boolean> {
  const r = await git(["add", "-A"], cwd);
  return r.code === 0;
}

/**
 * Commits with the message. With `edit`, git opens the user's editor pre-filled
 * (git owns the terminal meanwhile, so stdio is inherited).
 */
export async function commit(cwd: string, message: string, edit = false): Promise<{ ok: boolean; output: string }> {
  const dir = mkdtempSync(join(os.tmpdir(), "pikaclow-"));
  const file = join(dir, "COMMIT_MSG");
  writeFileSync(file, message.trim() + "\n");
  try {
    if (!edit) {
      const r = await git(["commit", "-F", file], cwd, 60000);
      return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
    }
    const code = await new Promise<number | null>((res) => {
      const child = spawn("git", ["commit", "-e", "-F", file], { cwd, stdio: "inherit" });
      child.on("error", () => res(null));
      child.on("close", res);
    });
    return { ok: code === 0, output: "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
