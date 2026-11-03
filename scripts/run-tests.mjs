// Cross-platform test runner: finds test/<suite>/**/*.test.ts and runs them with node:test + tsx.
// (npm scripts run under cmd.exe on Windows, which does not expand globs.)
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
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

// On GitHub Actions, failures also become annotations, which are readable without opening the logs.
const onCi = !!process.env.GITHUB_ACTIONS;
const tmp = onCi ? mkdtempSync(join(os.tmpdir(), "pikaclow-tap-")) : "";
const tap = join(tmp, "results.tap");
const result = spawnSync(
  process.execPath,
  [
    "--import", "tsx", "--test", "--test-concurrency=1", "--test-force-exit",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    ...(onCi ? ["--test-reporter=tap", `--test-reporter-destination=${tap}`] : []),
    ...files,
  ],
  { stdio: "inherit", env: { ...process.env, PIKACLOW_TEST: "1" } },
);

if (onCi && result.status !== 0) {
  try {
    annotate(readFileSync(tap, "utf8"));
  } catch {
    // no TAP output (crash before any test ran): the log has the details
  }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(result.status ?? 1);

/** Prints a ::error line for every failed test in node's TAP output. */
function annotate(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const detail = [];
    for (let j = i + 1; j < lines.length && !/^\s*(not )?ok \d+ /.test(lines[j]); j++) detail.push(lines[j].trim());
    if (detail.some((d) => /^failureType: 'subtestsFailed'/.test(d))) continue;
    const msg = detail.filter((d) => d && d !== "---" && d !== "...").slice(0, 40).join("\n");
    const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::error title=${esc(m[1]).replace(/[:,]/g, " ")}::${esc(msg.slice(0, 3500))}`);
  }
}
