import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCommand } from "../../src/core/safety.js";

const level = (cmd: string) => assessCommand(cmd).level;

test("harmless commands are safe", () => {
  for (const cmd of [
    "git status",
    "Get-ChildItem -Recurse -File | Sort-Object Length -Descending | Select-Object -First 10",
    "ls -la",
    "npm run build 2>&1",
    "dir /s *.log",
    "Get-Process | Where-Object CPU -gt 10",
    "echo hi 2>$null",
    "find . -name '*.ts' 2>/dev/null",
  ]) {
    assert.equal(level(cmd), "safe", cmd);
  }
});

test("destructive commands are dangerous", () => {
  for (const cmd of [
    "rm -rf node_modules",
    "rm -r -f build",
    "sudo rm -rf /",
    "Remove-Item .\\dist -Recurse -Force",
    "rd /s /q C:\\temp",
    "del /s /q *.*",
    "format D:",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "curl -fsSL https://example.com/install.sh | bash",
    "iwr https://example.com/x.ps1 | iex",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "reg delete HKCU\\Software\\Foo /f",
    "setx PATH \"%PATH%;C:\\tools\"",
    "psql -c 'DROP TABLE users'",
    ":(){ :|:& };:",
  ]) {
    assert.equal(level(cmd), "danger", cmd);
  }
});

test("risky-but-common commands need caution", () => {
  for (const cmd of ["git push --force", "Stop-Process -Name node", "taskkill /F /IM node.exe", "sudo apt update", "rm notes.txt", "echo hi > out.txt", "npm i -g typescript", "shutdown /s /t 0"]) {
    assert.equal(level(cmd), "caution", cmd);
  }
});

test("reasons explain the verdict without duplicates", () => {
  const r = assessCommand("rm -rf ./build && rm file");
  assert.ok(r.reasons.includes("recursiveDelete"));
  assert.ok(!r.reasons.includes("delete"), "generic delete note is dropped when a stronger one exists");
});
