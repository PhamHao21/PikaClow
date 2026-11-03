import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import { join, relative } from "node:path";
import { findJunk, folderSize, removeFolder } from "../../src/core/clean/scanner.js";
import { matchRule } from "../../src/core/clean/rules.js";

let root: string;

function file(path: string, bytes = 10): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), "x".repeat(bytes));
}

before(() => {
  root = mkdtempSync(join(os.tmpdir(), "pikaclow-clean-"));
  // A real JS project.
  file("web/package.json");
  file("web/node_modules/lodash/index.js", 5000);
  file("web/node_modules/lodash/fp/map.js", 1000);
  file("web/.next/cache/a.bin", 2000);
  file("web/dist/app.js", 300);
  // Source folders that merely share a junk-like name: must never be offered.
  file("web/src/build/index.ts");
  file("docs/out/chapter1.md");
  file("notes/build/todo.txt");
  // Other ecosystems.
  file("rust/Cargo.toml");
  file("rust/target/debug/app.exe", 4000);
  file("tools/py/__pycache__/a.cpython-312.pyc", 100);
  file("dotnet/App.csproj");
  file("dotnet/bin/Debug/App.dll", 700);
  // Hidden folders are not searched.
  file(".secret/project/package.json");
  file(".secret/project/node_modules/x/i.js");
});

after(() => rmSync(root, { recursive: true, force: true }));

test("finds only regenerable folders that sit next to a project marker", async () => {
  const found = await findJunk(root);
  const rel = found.map((f) => relative(root, f.path).replace(/\\/g, "/")).sort();
  assert.deepEqual(rel, ["dotnet/bin", "rust/target", "tools/py/__pycache__", "web/.next", "web/dist", "web/node_modules"]);
  assert.equal(found.find((f) => f.name === "dist")?.rule.risk, "verify");
  assert.equal(found.find((f) => f.name === "node_modules")?.rule.risk, "safe");
});

test("never descends into matched folders", async () => {
  file("web/node_modules/pkg/node_modules/inner/package.json");
  const found = await findJunk(root);
  assert.equal(found.filter((f) => f.name === "node_modules").length, 1);
});

test("measures folder sizes", async () => {
  const s = await folderSize(join(root, "web/node_modules"));
  assert.ok(s.bytes >= 6000, `bytes ${s.bytes}`);
  assert.ok(s.files >= 2);
});

test("respects maxDepth and cancellation", async () => {
  const shallow = await findJunk(root, { maxDepth: 0 });
  assert.equal(shallow.length, 0);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(findJunk(root, { signal: ac.signal }), /Aborted/);
});

test("rules need markers", () => {
  assert.equal(matchRule("build", new Set(["src"]), ["src"]), null);
  assert.equal(matchRule("build", new Set(["package.json"]), ["package.json"])?.id, "js-build");
  assert.equal(matchRule("target", new Set(["Cargo.toml"]), ["Cargo.toml"])?.id, "rust-target");
  assert.equal(matchRule("bin", new Set(["App.csproj"]), ["App.csproj"])?.id, "dotnet");
  assert.equal(matchRule("Library", new Set(["Assets"]), ["Assets"]), null);
  assert.equal(matchRule("Library", new Set(["Assets", "ProjectSettings"]), ["Assets", "ProjectSettings"])?.id, "unity");
});

test("removeFolder deletes a tree", async () => {
  file("gone/a/b/c.txt");
  await removeFolder(join(root, "gone"));
  assert.ok(!existsSync(join(root, "gone")));
});
