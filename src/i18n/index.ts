import { en, type Messages } from "./en.js";
import { vi } from "./vi.js";
import type { Lang } from "../core/config.js";

const dictionaries: Record<Lang, Messages> = { en, vi };

function detectLang(): Lang {
  const env = process.env.PIKACLOW_LANG ?? process.env.LC_ALL ?? process.env.LANG ?? "";
  if (/^vi/i.test(env)) return "vi";
  if (/^en/i.test(env)) return "en";
  try {
    if (/^vi/i.test(Intl.DateTimeFormat().resolvedOptions().locale)) return "vi";
  } catch {
    // Intl without locale data
  }
  return "en";
}

let current: Lang = detectLang();

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export type MessageKey = keyof Messages;

/** Translates a key, filling {placeholders} from vars. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const s = dictionaries[current][key] ?? en[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Translates a dynamic key when it exists (e.g. "risk." + reason), else returns fallback. */
export function tMaybe(key: string, fallback: string, vars?: Record<string, string | number>): string {
  if (key in en) return t(key as MessageKey, vars);
  return fallback;
}
