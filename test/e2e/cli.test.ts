// End-to-end tests: the real CLI in a pseudo-terminal, driven with key presses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { disposeAll, ROOT, Screen, sleep } from "./harness.js";

let home: string;
let fixture: string;

before(() => {
  home = mkdtempSync(join(os.tmpdir(), "pikaclow-home-"));
  fixture = mkdtempSync(join(os.tmpdir(), "pikaclow-fx-"));
  const f = (p: string, bytes = 20) => {
    mkdirSync(join(fixture, p, ".."), { recursive: true });
    writeFileSync(join(fixture, p), "x".repeat(bytes));
  };
  f("app/package.json");
  f("app/node_modules/dep/index.js", 4000);
  f("app/src/build/keep.ts");
  f("docs/out/keep.md");
});

after(async () => {
  await disposeAll();
  rmSync(home, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
});

const env = () => ({ PIKACLOW_HOME: home, PIKACLOW_LANG: "en" });

test("help lists the commands", async () => {
  const s = new Screen(["--help"], { env: env() });
  assert.equal(await s.waitExit(), 0);
  const text = s.allText();
  for (const cmd of ["dev [script]", "fix", "init [shell]", "dash", "ports [port]", "clean [path]", "doctor", "ask <question>", "sh <task>", "commit", "models", "setup"]) assert.ok(text.includes(cmd), cmd);
});

test("version and unknown-command suggestion", async () => {
  const v = new Screen(["--version"], { env: env() });
  assert.equal(await v.waitExit(), 0);
  assert.match(v.allText(), /\d+\.\d+\.\d+/);
  const u = new Screen(["prots"], { env: env() });
  assert.equal(await u.waitExit(), 1);
  assert.match(u.allText(), /Did you mean pikaclow ports\?/);
});

test("Vietnamese interface", async () => {
  const s = new Screen(["--lang", "vi", "--help"], { env: env() });
  await s.waitExit();
  assert.match(s.allText(), /Hệ thống/);
});

test("ports --json prints parseable JSON when piped", () => {
  // Piped, like `pikaclow ports --json | jq`: no terminal wrapping, no colors.
  const cli = join(ROOT, "src", "cli.ts");
  const out = execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "ports", "--json"], { env: { ...process.env, ...env() }, timeout: 30000 }).toString();
  const data = JSON.parse(out) as { port: number; pid: number }[];
  assert.ok(Array.isArray(data));
  for (const e of data) assert.ok(e.port > 0 && e.pid >= 0);
});

test("ports <free port> says it is free", async () => {
  const s = new Screen(["ports", "59999"], { env: env() });
  assert.equal(await s.waitExit(20000), 0);
  assert.match(s.allText(), /Port 59999 is free/);
});

test("clean --dry-run lists junk and deletes nothing", async () => {
  const s = new Screen(["clean", fixture, "--dry-run"], { env: env(), cols: 120 });
  assert.equal(await s.waitExit(20000), 0);
  const text = s.allText();
  assert.match(text, /node_modules/);
  assert.doesNotMatch(text, /src[\\/]build|docs[\\/]out/);
  assert.ok(existsSync(join(fixture, "app/node_modules")));
});

test("clean: pick, confirm and delete only the chosen folder", async () => {
  const s = new Screen(["clean", fixture], { env: env(), cols: 120 });
  await s.waitFor("Select folders to delete", 20000);
  s.press("space");
  await s.waitFor("1 selected");
  s.press("enter");
  await s.waitFor("Permanently delete 1 folders");
  s.write("y");
  await s.waitFor(/Freed .* \(1 folders\)/, 20000);
  assert.equal(await s.waitExit(), 0);
  assert.ok(!existsSync(join(fixture, "app/node_modules")), "node_modules removed");
  assert.ok(existsSync(join(fixture, "app/src/build/keep.ts")), "source kept");
  assert.ok(existsSync(join(fixture, "docs/out/keep.md")), "docs kept");
});

test("dash: switches views and quits cleanly", async () => {
  const s = new Screen(["dash"], { env: env(), cols: 110, rows: 32 });
  await s.waitFor("Top processes", 20000);
  await s.waitFor(/MEMORY/, 20000);
  s.press("tab");
  await s.waitFor("Processes · by CPU");
  s.press("s");
  await s.waitFor("Processes · by memory");
  s.write("q");
  assert.equal(await s.waitExit(), 0);
  assert.doesNotMatch(s.text(), /Processes · by/, "alternate screen was left");
});

test("dash --once prints a snapshot", async () => {
  const s = new Screen(["dash", "--once"], { env: env(), cols: 110, rows: 60 });
  assert.equal(await s.waitExit(30000), 0);
  assert.match(s.allText(), /Memory/);
  assert.match(s.allText(), /Disks/);
});

test("doctor reports checks and suggested fixes", async () => {
  const s = new Screen(["doctor"], { env: env(), cols: 120, rows: 40 });
  await s.waitExit(60000);
  assert.match(s.allText(), /Node\.js/);
  assert.match(s.allText(), /Git/);
});

test("interactive home: slash menu, shell command, Ctrl+C twice quits", async () => {
  const s = new Screen([], { env: env(), cols: 100, rows: 40 });
  await s.waitFor("Tips for getting started", 20000);
  s.write("/po");
  await s.waitFor("/ports [port]");
  s.press("esc");
  // Node waits up to 500 ms to tell a lone Esc from an escape sequence.
  await sleep(700);
  await s.waitFor(/► Ask anything/);
  s.write("!echo pika-test-123");
  s.press("enter");
  await s.waitFor(/^pika-test-123/m, 20000);
  s.write("/help");
  s.press("enter");
  await s.waitFor("KEYS", 10000);
  s.press("ctrl+c");
  await s.waitFor("Press Ctrl+C again");
  s.press("ctrl+c");
  await s.waitFor("See you!");
  assert.equal(await s.waitExit(), 0);
});

test("interactive home: nested screens hand the keyboard back", async () => {
  // Fresh junk, since the clean test above removed the fixture's node_modules.
  mkdirSync(join(fixture, "app/node_modules/dep"), { recursive: true });
  writeFileSync(join(fixture, "app/node_modules/dep/index.js"), "x".repeat(4000));
  const s = new Screen([], { env: env(), cols: 100, rows: 34 });
  await s.waitFor("Tips for getting started", 20000);
  s.write("pikaclow dash");
  s.press("enter");
  await s.waitFor("Top processes", 20000);
  s.write("q");
  await s.waitFor(/► Ask anything/, 10000);
  s.write("/clean " + fixture);
  s.press("enter");
  await s.waitFor("Select folders to delete", 20000);
  s.press("esc");
  await s.waitFor("Nothing was deleted", 10000);
  await s.waitFor(/► Ask anything/, 10000);
  s.write("/ports 59997");
  s.press("enter");
  await s.waitFor("Port 59997 is free", 20000);
  s.press("ctrl+c");
  await sleep(200);
  s.press("ctrl+c");
  await s.waitFor("See you!");
  assert.equal(await s.waitExit(), 0);
});

test("interactive home: history recalls the previous input", async () => {
  const s = new Screen([], { env: env(), cols: 100, rows: 40 });
  await s.waitFor("Tips for getting started", 20000);
  s.write("/help");
  s.press("enter");
  await s.waitFor("KEYS", 10000);
  await sleep(300);
  s.press("up");
  await s.waitFor(/► \/help/);
  // First Ctrl+C clears the input, the next two quit.
  s.press("ctrl+c");
  await s.waitFor(/► Ask anything/);
  s.press("ctrl+c");
  s.press("ctrl+c");
  await s.waitFor("See you!");
  assert.equal(await s.waitExit(), 0);
});
