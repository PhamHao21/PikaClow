/** 1536 → "1.5 KB". Uses binary units, like Task Manager and Explorer. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : digits)) + " " + units[i];
}

/** Bytes per second → "1.2 MB/s". */
export function formatRate(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + "/s";
}

/** Milliseconds → "3 days", "5 months" (coarse, for "last touched"). */
export function formatAge(ms: number, units: { day: string; days: string; month: string; months: string; year: string; years: string; today: string }): string {
  const days = Math.floor(ms / 86400000);
  if (days < 1) return units.today;
  if (days < 45) return `${days} ${days === 1 ? units.day : units.days}`;
  const months = Math.floor(days / 30);
  if (months < 18) return `${months} ${months === 1 ? units.month : units.months}`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? units.year : units.years}`;
}

/** Replaces every occurrence of the home folder inside a longer text (e.g. a command line). */
export function tildifyText(text: string, home: string): string {
  if (!home || home.length < 3) return text;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped + "(?=[\\\\/\"]|$)", process.platform === "win32" ? "gi" : "g"), "~");
}

/** Shows home-relative paths: C:\Users\me\code → ~\code. */
export function tildify(p: string, home: string): string {
  if (!home) return p;
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  if (norm(p) === norm(home)) return "~";
  if (norm(p).startsWith(norm(home) + (process.platform === "win32" ? "\\" : "/"))) return "~" + p.slice(home.length);
  return p;
}
