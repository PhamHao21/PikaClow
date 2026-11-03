import { test } from "node:test";
import assert from "node:assert/strict";
import { hasLoader, hookScript, loaderBlock, parseFailed, shellPath, withLoader, withoutLoader } from "../../src/core/hook.js";

const home = process.platform === "win32" ? "C:\\Users\\pika" : "/home/pika";
const join = (...p: string[]) => [home, ...p].join(process.platform === "win32" ? "\\" : "/");

test("shellPath writes paths under home relative to $HOME", () => {
  const p = join(".pikaclow", "hook.ps1");
  assert.equal(shellPath("powershell", p, home), '"$HOME\\.pikaclow\\hook.ps1"');
  assert.equal(shellPath("bash", join(".pikaclow", "hook.bash"), home), '"$HOME/.pikaclow/hook.bash"');
  assert.equal(shellPath("fish", "/opt/it's/hook.fish", home), "'/opt/it\\'s/hook.fish'");
  assert.equal(shellPath("zsh", "/opt/it's/hook.zsh", home), "'/opt/it'\\''s/hook.zsh'");
});

test("loader block is added once, refreshed in place and removed cleanly", () => {
  const block = loaderBlock("bash", "/home/pika/.pikaclow/hook.bash");
  const original = "export PATH=$PATH:~/bin\nalias ll='ls -l'\n";
  const once = withLoader(original, block);
  assert.ok(hasLoader(once));
  assert.equal(withLoader(once, block), once, "idempotent");
  assert.equal(once.split("# >>> pikaclow >>>").length, 2);
  assert.equal(withoutLoader(once), original);
  assert.equal(withLoader("", block), block + "\n");
  assert.equal(withLoader(withLoader("", block), block), block + "\n", "a block at the top stays at the top");
});

test("loader block keeps CRLF profiles CRLF", () => {
  const ps = withLoader("Import-Module posh-git\r\n", loaderBlock("powershell", "C:\\x\\hook.ps1", "\r\n"));
  assert.ok(!/[^\r]\n/.test(ps), "no bare LF");
  assert.match(ps, /if \(Test-Path -LiteralPath 'C:\\x\\hook\.ps1'\) \{ \. 'C:\\x\\hook\.ps1' \}/);
});

test("hook scripts record failures, skip quiet commands and bind Alt+Z", () => {
  for (const shell of ["powershell", "bash", "zsh", "fish"] as const) {
    const s = hookScript(shell, "press Alt+Z");
    assert.match(s, /last-failed/, shell);
    assert.match(s, /pikaclow fix/, shell);
    assert.match(s, /grep/, shell + " quiet list");
    // PowerShell carries the hint as base64 so the script stays ASCII-only.
    const hint = shell === "powershell" ? Buffer.from("press Alt+Z").toString("base64") : "press Alt+Z";
    assert.ok(s.includes(hint), shell + " hint");
  }
  assert.ok(!/[^\x00-\x7f]/.test(hookScript("powershell", "bấm Alt+Z ⚡")), "PowerShell hook is ASCII-only");
  assert.match(hookScript("bash", "x"), /PROMPT_COMMAND="__pikaclow_hook/);
  assert.match(hookScript("zsh", "x"), /precmd_functions=\(__pikaclow_precmd/);
  assert.match(hookScript("powershell", "x"), /Set-PSReadLineKeyHandler -Chord 'Alt\+z'/);
  // A hint with quotes cannot break out of the string.
  assert.match(hookScript("bash", "it's \"fine\""), /'it'\\''s "fine"'/);
});

test("parseFailed reads the state file, multi-line commands and Git Bash paths", () => {
  const f = parseFailed("1\nbash\n/home/pika/app\nnpm run dev\n", 5);
  assert.deepEqual(f, { code: 1, shell: "bash", cwd: "/home/pika/app", command: "npm run dev", at: 5 });
  assert.equal(parseFailed("\uFEFF2\r\npowershell\r\nC:\\app\r\nfoo\r\nbar\r\n")?.command, "foo\nbar");
  assert.equal(parseFailed("garbage"), null);
  assert.equal(parseFailed("x\nbash\n/\ncmd\n"), null);
  if (process.platform === "win32") assert.equal(parseFailed("1\nbash\n/d/work/app\nls\n")?.cwd, "D:\\work\\app");
});
