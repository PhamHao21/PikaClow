import { test } from "node:test";
import assert from "node:assert/strict";
import { matchKnownErrors } from "../../src/core/errors-kb.js";
import { heuristicMessage } from "../../src/core/commit-heuristic.js";

test("known errors: port in use offers to free the port", () => {
  const [hit] = matchKnownErrors("Error: listen EADDRINUSE: address already in use :::3000\n    at Server.setupListenHandle");
  assert.equal(hit?.id, "portInUse");
  assert.equal(hit?.vars.port, "3000");
  assert.deepEqual(hit?.action, { type: "kill-port", port: 3000 });
});

test("known errors: Vite and Next style port messages", () => {
  assert.equal(matchKnownErrors("Error: Port 5173 is already in use")[0]?.vars.port, "5173");
});

test("known errors: PowerShell execution policy", () => {
  const out = "npm : File C:\\Program Files\\nodejs\\npm.ps1 cannot be loaded because running scripts is disabled on this system.";
  const [hit] = matchKnownErrors(out);
  assert.equal(hit?.id, "execPolicy");
  assert.match(hit!.fixes[0]!, /RemoteSigned/);
});

test("known errors: missing modules and commands", () => {
  assert.equal(matchKnownErrors("Error: Cannot find module 'express'")[0]?.vars.module, "express");
  assert.deepEqual(matchKnownErrors("Error: Cannot find module 'express'")[0]?.fixes, ["npm install", "npm install express"]);
  assert.deepEqual(matchKnownErrors("Error: Cannot find module './util'")[0]?.fixes, ["npm install"]);
  assert.equal(matchKnownErrors("ModuleNotFoundError: No module named 'requests.adapters'")[0]?.fixes[0], "pip install requests");
  assert.equal(matchKnownErrors("'pnpm' is not recognized as an internal or external command,")[0]?.vars.cmd, "pnpm");
  assert.equal(matchKnownErrors("bash: yarn: command not found")[0]?.vars.cmd, "yarn");
});

test("known errors: ANSI colors do not hide matches; unknown output matches nothing", () => {
  assert.equal(matchKnownErrors("\x1b[31mnpm ERR! ERESOLVE unable to resolve dependency tree\x1b[0m")[0]?.id, "eresolve");
  assert.deepEqual(matchKnownErrors("all good, 12 tests passed"), []);
});

test("offline commit messages pick sensible types and scopes", () => {
  assert.equal(heuristicMessage([{ status: "M", path: "README.md" }]), "docs: update README.md");
  assert.equal(heuristicMessage([{ status: "A", path: "src/ui/button.ts" }]), "feat(ui): add button.ts");
  assert.match(heuristicMessage([{ status: "M", path: "package.json" }, { status: "M", path: "package-lock.json" }]), /^build: update package\.json and package-lock\.json/);
  assert.match(heuristicMessage([{ status: "M", path: ".github/workflows/ci.yml" }]), /^ci: /);
  assert.match(heuristicMessage([{ status: "M", path: "test/a.test.ts" }, { status: "A", path: "test/b.test.ts" }]), /^test: /);
  assert.equal(heuristicMessage([{ status: "D", path: "src/old.ts" }]), "refactor(old): remove old.ts");
  assert.match(heuristicMessage([{ status: "A", path: "src/api/users.ts" }], "vi"), /^feat\(api\): thêm users\.ts/);
});
