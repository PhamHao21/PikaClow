// Cross-platform test runner: finds test/<suite>/**/*.test.ts and runs them with node:test + tsx.
// (npm scripts run under cmd.exe on Windows, which does not expand globs.)
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const suites = process.argv.slice(2);
if (suites.length === 0) suites.push("unit");

function collect(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...collect(full));
    else if (name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

const files = suites.flatMap((s) => collect(join("test", s))).sort();
if (files.length === 0) {
  console.error("No test files found for: " + suites.join(", "));
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=spec", "--test-force-exit", ...files],
  { stdio: "inherit", env: { ...process.env, PIKACLOW_TEST: "1" } },
);
process.exit(result.status ?? 1);
