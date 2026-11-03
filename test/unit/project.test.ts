import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { detectFramework, findProject, pickScript, runArgs } from "../../src/core/project.js";
import { compareVersions } from "../../src/core/update.js";

test("findProject walks up to package.json and reads the package manager", () => {
  const root = mkdtempSync(join(os.tmpdir(), "pika-proj-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop", scripts: { dev: "vite" }, devDependencies: { vite: "6" } }));
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    const p = findProject(join(root, "src", "deep"))!;
    assert.equal(p.root, root);
    assert.equal(p.name, "shop");
    assert.equal(p.pm, "pnpm");
    assert.equal(p.pmReason, "pnpm-lock.yaml");
    assert.ok(p.deps.has("vite"));
    assert.equal(p.hasNodeModules, false);
    // The packageManager field wins over lockfiles.
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.5.0" }));
    assert.equal(findProject(root)!.pm, "yarn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pickScript prefers dev, then the usual names", () => {
  assert.equal(pickScript({ build: "x", start: "node ." }), "start");
  assert.equal(pickScript({ start: "node .", dev: "vite" }), "dev");
  assert.equal(pickScript({ build: "x" }), null);
  assert.equal(pickScript({ web: "x" }, "web"), "web");
  assert.equal(pickScript({ web: "x" }, "api"), null);
});

test("detectFramework knows ports and how to move them", () => {
  assert.deepEqual(detectFramework("vite"), { name: "Vite", port: 5173, portFlag: "--port", fixedPort: false });
  assert.deepEqual(detectFramework("next dev --turbopack"), { name: "Next.js", port: 3000, portFlag: "-p", fixedPort: false });
  assert.equal(detectFramework("astro dev")?.port, 4321);
  assert.equal(detectFramework("ng serve")?.port, 4200);
  assert.deepEqual(detectFramework("vite --port 4000"), { name: "Vite", port: 4000, portFlag: null, fixedPort: true });
  assert.deepEqual(detectFramework("node server.js"), null);
  assert.deepEqual(detectFramework("PORT=8080 node server.js"), { name: "", port: 8080, portFlag: null, fixedPort: true });
  // A wrapper script still gets the port from the dependencies.
  assert.equal(detectFramework("turbo run dev", new Set(["next"]))?.port, 3000);
});

test("runArgs adds the -- separator only for npm", () => {
  assert.deepEqual(runArgs("npm", "dev"), ["run", "dev"]);
  assert.deepEqual(runArgs("npm", "dev", ["--port", "5174"]), ["run", "dev", "--", "--port", "5174"]);
  assert.deepEqual(runArgs("pnpm", "dev", ["--port", "5174"]), ["run", "dev", "--port", "5174"]);
});

test("compareVersions orders releases and prereleases", () => {
  assert.equal(compareVersions("0.9.1", "0.9.0"), 1);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.2"), 1);
  assert.equal(compareVersions("v2.0.0", "1.9.9"), 1);
});
