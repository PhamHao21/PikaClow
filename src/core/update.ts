// Update check: at most once a day a detached helper asks the npm registry for the
// latest version and caches it. Commands never wait for the network; they only read
// the cache, so a slow or offline registry costs nothing.
import { spawn } from "node:child_process";
import { readCache, writeCache } from "./config.js";
import { NAME, VERSION } from "../version.js";

const CACHE = "update.json";
const NOTICE = "update-notice.json";
const DAY = 24 * 60 * 60 * 1000;
export const UPDATE_COMMAND = "__update-check";

interface UpdateInfo {
  latest: string | null;
}

/** Compares x.y.z versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function updateChecksEnabled(): boolean {
  const e = process.env;
  return !e.CI && !e.PIKACLOW_TEST && e.PIKACLOW_NO_UPDATE_CHECK !== "1" && !e.NO_UPDATE_NOTIFIER;
}

/** The newer version from the cache, if there is one. */
export function availableUpdate(): string | null {
  const latest = readCache<UpdateInfo>(CACHE, Infinity)?.latest;
  return latest && compareVersions(latest, VERSION) > 0 ? latest : null;
}

/** Starts the background check when the cached answer is older than a day. */
export function scheduleUpdateCheck(): void {
  if (!updateChecksEnabled() || readCache<UpdateInfo>(CACHE, DAY)) return;
  // Mark the attempt first, so an offline machine does not spawn a helper on every run.
  writeCache<UpdateInfo>(CACHE, { latest: readCache<UpdateInfo>(CACHE, Infinity)?.latest ?? null });
  try {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? "", UPDATE_COMMAND], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // never let the update check get in the way
  }
}

/** Body of the hidden helper command. */
export async function runUpdateCheck(): Promise<void> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${NAME}/latest`, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version === "string") writeCache<UpdateInfo>(CACHE, { latest: data.version });
  } catch {
    // offline: try again tomorrow
  }
}

/** True once a day per new version, so the notice is helpful rather than nagging. */
export function shouldShowNotice(latest: string): boolean {
  const seen = readCache<{ version: string }>(NOTICE, DAY);
  if (seen?.version === latest) return false;
  writeCache(NOTICE, { version: latest });
  return true;
}
