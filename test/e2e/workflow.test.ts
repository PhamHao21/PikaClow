// End-to-end tests for the workflow commands: init (shell integration), fix and dev.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { disposeAll, Screen } from "./harness.js";

let home: string;
let user: string;
let project: string;

before(() => {
  home = mkdtempSync(join(os.tmpdir(), "pikaclow-home-"));
  user = mkdtempSync(join(os.tmpdir(), "pikaclow-user-"));
  project = mkdtempSync(join(os.tmpdir(), "pikaclow-dev-"));
  // A fake Vite: listens on --port (default 5173) and says so.
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo-shop", scripts: { dev: "node ./node_modules/vite/bin/vite.js" } }));
  mkdirSync(join(project, "node_modules", "vite", "bin"), { recursive: true });
  writeFileSync(
    join(project, "node_modules", "vite", "bin", "vite.js"),
    "const i = process.argv.indexOf('--port'); const port = i > 0 ? Number(process.argv[i + 1]) : 5173;\n" +
      "require('http').createServer((q, r) => r.end('ok')).listen(port, () => console.log('ready on ' + port));\n",
  );
});

after(async () => {
  await disposeAll();
  for (const d of [home, user, project]) rmSync(d, { recursive: true, force: true });
});

// A throwaway home folder, so profiles are written there and never in the real one.
const env = () => ({ PIKACLOW_HOME: home, PIKACLOW_LANG: "en", HOME: user, USERPROFILE: user, ZDOTDIR: "" });
const recordShell = process.platform === "win32" ? "powershell" : "bash";

test("init bash installs the hook once, updates it, and uninstalls it", async () => {
  const s = new Screen(["init", "bash", "--yes"], { env: env() });
  assert.equal(await s.waitExit(20000), 0);
  assert.match(s.allText(), /Shell integration is on for bash/);
  const rc = readFileSync(join(user, ".bashrc"), "utf8");
  // PIKACLOW_HOME is outside the fake home here, so the path is written out in full.
  assert.match(rc, /# >>> pikaclow >>>\n\[ -f '[^']*\/hook\.bash' \] && \. '[^']*\/hook\.bash'\n# <<< pikaclow <<<\n$/);
  assert.ok(existsSync(join(home, "hook.bash")));

  const again = new Screen(["init", "bash", "--yes"], { env: env() });
  assert.equal(await again.waitExit(20000), 0);
  assert.match(again.allText(), /updated/);
  assert.equal(readFileSync(join(user, ".bashrc"), "utf8"), rc, "running init twice changes nothing");

  const off = new Screen(["init", "bash", "--uninstall"], { env: env() });
  assert.equal(await off.waitExit(20000), 0);
  assert.doesNotMatch(readFileSync(join(user, ".bashrc"), "utf8"), /pikaclow/);
  assert.ok(!existsSync(join(home, "hook.bash")));
});

test("init --print writes the hook script for manual setups", async () => {
  const s = new Screen(["init", "zsh", "--print"], { env: env() });
  assert.equal(await s.waitExit(20000), 0);
  assert.match(s.allText(), /add-zsh-hook preexec __pikaclow_preexec/);
});

test("fix without a recorded failure points to init", async () => {
  rmSync(join(home, "last-failed"), { force: true });
  const s = new Screen(["fix"], { env: env() });
  assert.equal(await s.waitExit(20000), 0);
  assert.match(s.allText(), /No failed command recorded yet/);
  assert.match(s.allText(), /pikaclow init/);
});

test("fix re-runs the last failed command and explains it", async () => {
  writeFileSync(join(home, "last-failed"), ["1", recordShell, project, "node missing-file-xyz.js"].join("\n") + "\n");
  const s = new Screen(["fix", "--no-ai"], { env: env(), cols: 110, rows: 40 });
  await s.waitFor("What should PikaClow do?", 20000);
  assert.match(s.text(), /node missing-file-xyz\.js/);
  s.press("enter");
  await s.waitFor("Exited with code 1", 30000);
  assert.match(s.allText(), /Cannot find module/);
  assert.equal(await s.waitExit(20000), 0);
});

test("fix will not silently re-run a dangerous command", async () => {
  writeFileSync(join(home, "last-failed"), ["1", recordShell, project, "rm -rf ./build"].join("\n") + "\n");
  const s = new Screen(["fix", "--yes", "--no-ai"], { env: env(), cols: 110, rows: 40 });
  assert.equal(await s.waitExit(30000), 0);
  assert.match(s.allText(), /will not run it again on its own/);
  assert.doesNotMatch(s.allText(), /Exited with code/);
});

test("dev finds the busy port, moves to a free one, and stops on Ctrl+C", async (t) => {
  const blocker = net.createServer();
  const bound = await new Promise<boolean>((resolve) => {
    blocker.once("error", () => resolve(false));
    blocker.listen(5173, () => resolve(true));
  });
  if (!bound) return t.skip("port 5173 is already used on this machine");
  try {
    const s = new Screen(["dev"], { env: env(), cwd: project, cols: 110, rows: 40 });
    await s.waitFor("Port 5173 is busy. What now?", 30000);
    assert.match(s.allText(), /Vite/);
    assert.match(s.allText(), /npm/);
    s.press("down");
    s.press("enter");
    await s.waitFor(/ready on (\d+)/, 40000);
    const port = Number(/ready on (\d+)/.exec(s.allText())![1]);
    assert.notEqual(port, 5173);
    s.press("ctrl+c");
    await s.waitFor("Dev server stopped", 20000);
    assert.equal(await s.waitExit(20000), 0);
  } finally {
    blocker.close();
  }
});

test("a newer version in the cache shows an update notice once", async () => {
  mkdirSync(join(home, "cache"), { recursive: true });
  writeFileSync(join(home, "cache", "update.json"), JSON.stringify({ at: Date.now(), data: { latest: "99.0.0" } }));
  rmSync(join(home, "cache", "update-notice.json"), { force: true });
  const s = new Screen(["ports", "59998"], { env: env() });
  assert.equal(await s.waitExit(20000), 0);
  assert.match(s.allText(), /PikaClow 99\.0\.0 is available/);
  const again = new Screen(["ports", "59998"], { env: env() });
  assert.equal(await again.waitExit(20000), 0);
  assert.doesNotMatch(again.allText(), /is available/, "not nagging twice a day");
  rmSync(join(home, "cache", "update.json"), { force: true });
});

test("dev outside a project says so", async () => {
  const s = new Screen(["dev"], { env: env(), cwd: user });
  assert.equal(await s.waitExit(20000), 1);
  assert.match(s.allText(), /No package\.json/);
});
