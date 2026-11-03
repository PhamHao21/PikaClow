import { write } from "./terminal.js";

/** Writes lines to stdout. */
export function print(...lines: string[]): void {
  write(lines.map((l) => l + "\n").join(""));
}

export function blank(): void {
  write("\n");
}

/** Machine-readable output for --json. */
export function printJson(data: unknown): void {
  write(JSON.stringify(data, null, 2) + "\n");
}
