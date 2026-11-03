// Regenerates the README screenshots in docs/ (SVG). Runs the real CLI in a
// pseudo-terminal against a mock AI server, inside a neutral demo folder, so no
// personal paths or machine names end up in the images.
//
//   npm run screenshots
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { disposeAll, ROOT, Screen, sleep } from "../test/e2e/harness.js";
import { startMockAi } from "../test/helpers/mock-ai.js";

const mock = await startMockAi({ models: ["qwen3:4b", "qwen3:1.7b", "gemma3:4b"] });
const demo = join(os.tmpdir(), "pikaclow-demo");
rmSync(demo, { recursive: true, force: true });
const app = join(demo, "my-app");
const home = join(demo, ".pikaclow");
const out = join(ROOT, "docs");
mkdirSync(out, { recursive: true });

const file = (p: string, content = "x") => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};

// A demo project with a fake Vite dev server listening on 5173.
file(join(app, "package.json"), '{ "name": "my-app" }');
file(join(app, "node_modules", "vite", "bin", "vite.js"), "require('http').createServer((q, r) => r.end('ok')).listen(5173);");
file(join(app, "src", "main.ts"), "console.log('hi')\n");
const server = spawn(process.execPath, [join(app, "node_modules", "vite", "bin", "vite.js")], { stdio: "ignore" });
// Some junk to clean, spread over a few "projects".
const junk: [string, number][] = [
  ["shop/package.json", 10], ["shop/node_modules/react/index.js", 1_900_000], ["shop/.next/cache/a.bin", 700_000],
  ["api/package.json", 10], ["api/node_modules/express/index.js", 3_400_000], ["api/dist/server.js", 20_000],
  ["game/Cargo.toml", 10], ["game/target/debug/game.exe", 6_500_000], ["ml/notebooks/__pycache__/m.pyc", 90_000],
];
for (const [p, n] of junk) file(join(demo, "code", p), "x".repeat(n));
// A git repo with staged changes for the commit demo.
const git = (...a: string[]) => execFileSync("git", a, { cwd: app });
git("init", "-q");
git("config", "user.name", "Demo");
git("config", "user.email", "demo@example.com");
git("add", ".");
git("commit", "-qm", "chore: init");
file(join(app, "src", "auth", "login.ts"), "export const login = () => {}\n");
file(join(app, "src", "auth", "session.ts"), "export const session = {}\n");
git("add", ".");
// A second project whose dev server wants the port my-app already holds.
const web = join(demo, "web");
file(join(web, "package.json"), JSON.stringify({ name: "web", scripts: { dev: "vite" }, devDependencies: { vite: "^6.0.0" } }));
file(join(web, "package-lock.json"), JSON.stringify({ name: "web", lockfileVersion: 3 }));
file(join(web, "node_modules", ".keep"), "");
// The last command that failed in the shell, as the hook records it.
file(join(home, "last-failed"), ["1", "powershell", app, "npm run build"].join("\n") + "\n");

const env = {
  PIKACLOW_HOME: home,
  PIKACLOW_LANG: "en",
  PIKACLOW_PROVIDER: "ollama",
  PIKACLOW_BASE_URL: mock.url,
  PIKACLOW_MODEL: "qwen3:4b",
  // A neutral home folder, so screenshots show "~" instead of a real user path.
  USERPROFILE: demo,
  HOME: demo,
  // Present as Windows PowerShell, whatever shell runs this script.
  MSYSTEM: "",
  SHELL: "",
  PROMPT: "",
};

async function shot(name: string, args: string[], steps: (s: Screen) => Promise<void>, size: { cols?: number; rows?: number } = {}, cwd = app, title = "pikaclow " + args.join(" ")) {
  const s = new Screen(args, { cols: size.cols ?? 100, rows: size.rows ?? 30, env, cwd });
  try {
    await steps(s);
    writeFileSync(join(out, name + ".svg"), s.svg(title));
    mkdirSync(join(ROOT, ".snapshots"), { recursive: true });
    writeFileSync(join(ROOT, ".snapshots", "shot-" + name + ".html"), s.html(name));
    console.log("✔", name);
  } catch (e) {
    console.log("✖", name, (e as Error).message.split("\n")[0]);
  } finally {
    s.kill();
  }
}

try {
  await sleep(800);
  await shot("home", [], async (s) => {
    await s.waitFor("qwen3:4b · Ollama", 20000);
    s.write("/");
    await sleep(500);
  }, { rows: 30 });

  mock.reply = "You can undo the last commit but **keep your changes** staged:\n\n```powershell\ngit reset --soft HEAD~1\n```\n\nUse `--hard` only if you want to throw the changes away.";
  await shot("chat", [], async (s) => {
    await s.waitFor("qwen3:4b · Ollama", 20000);
    s.write("how do I undo my last commit?");
    s.press("enter");
    await s.waitFor("throw the changes away", 20000);
    await sleep(600);
  }, { rows: 22 });

  await shot("ports", ["ports", "5173"], async (s) => {
    await s.waitFor("Next free port", 20000);
  }, { rows: 12 });

  mock.reply = "COMMAND: Get-ChildItem -Recurse -File | Sort-Object Length -Descending | Select-Object -First 10 FullName, Length\nEXPLAIN: Lists the 10 biggest files in this folder and its subfolders.";
  await shot("sh", ["sh", "10 biggest files here"], async (s) => {
    await s.waitFor("Run it?", 20000);
  }, { cols: 110, rows: 16 });

  mock.reply = "COMMAND: git reset --hard HEAD~3; git clean -fdx\nEXPLAIN: Drops the last 3 commits and deletes every untracked file.";
  await shot("sh-danger", ["sh", "start over from 3 commits ago"], async (s) => {
    await s.waitFor("Run it?", 20000);
  }, { cols: 110, rows: 17 });

  mock.reply = "feat(auth): add login and session modules\n\n- add login() entry point\n- add session store";
  await shot("commit", ["commit"], async (s) => {
    await s.waitFor("Use this message?", 20000);
  }, { rows: 20 });

  mock.reply = "**Cause:** Vite from another project is still running on port 5173.\n\n**Fix:** stop it (PikaClow can do it for you), or start this one on another port:\n```powershell\nnpm run dev -- --port 5174\n```";
  await shot("explain", ["explain", "Error: Port 5173 is already in use"], async (s) => {
    await s.waitFor("Stop it and free port 5173?", 20000);
  }, { rows: 16 });

  await shot("clean", ["clean", join(demo, "code")], async (s) => {
    await s.waitFor("Select folders to delete", 20000);
    s.press("down");
    s.press("space");
    await sleep(400);
  }, { cols: 110, rows: 17 }, app, "pikaclow clean ~/code");

  await shot("dev", ["dev"], async (s) => {
    await s.waitFor("What now?", 30000);
    await sleep(300);
  }, { cols: 100, rows: 20 }, web);

  await shot("fix", ["fix"], async (s) => {
    await s.waitFor("What should PikaClow do?", 20000);
    await sleep(300);
  }, { cols: 100, rows: 17 });

  await shot("models", ["models"], async (s) => {
    await s.waitFor("Download or switch the default model?", 30000);
  }, { cols: 110, rows: 60 });
} finally {
  await disposeAll();
  server.kill();
  await mock.close();
  rmSync(demo, { recursive: true, force: true });
}
process.exit(0);
