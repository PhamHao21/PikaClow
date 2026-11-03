import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

export type Lang = "en" | "vi";
export type ProviderKind = "ollama" | "openai";

export interface AiConfig {
  provider: ProviderKind;
  model?: string;
  baseUrl?: string;
  /** Name of the environment variable holding the API key (preferred). */
  apiKeyEnv?: string;
  /** API key stored in the config file (file is created user-readable only). */
  apiKey?: string;
}

export interface Config {
  lang?: Lang;
  theme?: "dark" | "light";
  ai?: AiConfig;
  /** Language for generated commit messages (defaults to English). */
  commitLang?: Lang;
}

/** ~/.pikaclow, or $PIKACLOW_HOME. */
export function appHome(): string {
  return process.env.PIKACLOW_HOME || join(os.homedir(), ".pikaclow");
}

export const configPath = () => join(appHome(), "config.json");
export const historyPath = () => join(appHome(), "history");
export const cachePath = (name: string) => join(appHome(), "cache", name);

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  try {
    const data = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    cached = data && typeof data === "object" ? (data as Config) : {};
  } catch {
    cached = {};
  }
  return cached;
}

/** Merges `patch` into the config (top-level keys are replaced) and writes it atomically. */
export function saveConfig(patch: Partial<Config>): Config {
  const next: Config = { ...loadConfig(), ...patch };
  const dir = appHome();
  mkdirSync(dir, { recursive: true });
  const file = configPath();
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op on Windows
  }
  cached = next;
  return next;
}

/** Reads a small JSON cache file; returns null when missing or older than maxAgeMs. */
export function readCache<T>(name: string, maxAgeMs: number): T | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(name), "utf8")) as { at: number; data: T };
    if (Date.now() - raw.at > maxAgeMs) return null;
    return raw.data;
  } catch {
    return null;
  }
}

export function writeCache<T>(name: string, data: T): void {
  try {
    mkdirSync(join(appHome(), "cache"), { recursive: true });
    writeFileSync(cachePath(name), JSON.stringify({ at: Date.now(), data }));
  } catch {
    // caching is best-effort
  }
}
