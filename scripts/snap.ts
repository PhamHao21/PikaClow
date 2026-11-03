// Visual snapshot tool: runs PikaClow in a pseudo-terminal, optionally presses keys,
// and saves the screen as colored HTML in .snapshots/.
//
//   npm run snap -- --cols 100 --rows 32 --name home --keys "wait:800,/,wait:300" -- ports
//
// Keys: comma-separated; "wait:<ms>", named keys (enter, up, down, tab, esc, space, ctrl+c…)
// or literal text ("text:hello").
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Screen, sleep } from "../test/e2e/harness.js";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep >= 0 ? argv.slice(0, sep) : argv;
const cliArgs = sep >= 0 ? argv.slice(sep + 1) : [];

function opt(name: string, def: string): string {
  const i = opts.indexOf("--" + name);
  return i >= 0 && opts[i + 1] !== undefined ? opts[i + 1]! : def;
}

const cols = Number(opt("cols", "100"));
const rows = Number(opt("rows", "30"));
const name = opt("name", "snap");
const keys = opt("keys", "");
const waitMs = Number(opt("wait", "1500"));
const script = opt("script", "");
const env: Record<string, string> = {};
for (const kv of opt("env", "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  if (k) env[k] = v ?? "";
}

const screen = new Screen(cliArgs, { cols, rows, env, ...(script ? { script: join(ROOT, script) } : {}) });
await sleep(waitMs);
for (const k of keys.split(",").filter(Boolean)) {
  if (k.startsWith("wait:")) await sleep(Number(k.slice(5)));
  else if (k.startsWith("text:")) screen.write(k.slice(5));
  else screen.press(k);
  await sleep(120);
}
await screen.settle(500);
const dir = join(ROOT, ".snapshots");
mkdirSync(dir, { recursive: true });
const file = join(dir, name + ".html");
writeFileSync(file, screen.html(name));
writeFileSync(join(dir, name + ".txt"), screen.text());
console.log(screen.text());
console.log("\n→ " + file + (screen.exitCode !== null ? `  (exit ${screen.exitCode})` : ""));
screen.kill();
process.exit(0);
