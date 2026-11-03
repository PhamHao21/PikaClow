import { test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../../src/i18n/en.js";
import { vi } from "../../src/i18n/vi.js";
import { estimate, recommend } from "../../src/core/models/estimate.js";
import { CATALOG } from "../../src/core/models/catalog.js";
import type { Hardware } from "../../src/core/models/hardware.js";

const GB = 1024 ** 3;
const laptop: Hardware = {
  os: "Windows 11",
  arch: "x64",
  cpu: "Intel Core i3-1115G4",
  threads: 4,
  ramTotal: 16 * GB,
  ramFree: 8 * GB,
  memType: "DDR4",
  memSpeed: 3200,
  memModules: 2,
  cpuBandwidth: 23,
  gpus: [],
  unified: false,
};
const gamer: Hardware = { ...laptop, ramTotal: 32 * GB, ramFree: 20 * GB, threads: 16, cpuBandwidth: 40, gpus: [{ vendor: "NVIDIA", model: "RTX 4070", vram: 12 * GB, dedicated: true, bandwidth: 504 }] };

const model = (id: string) => CATALOG.find((m) => m.id === id)!;

test("every English message has a Vietnamese translation with the same placeholders", () => {
  const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.ok(vi[key], `missing vi: ${key}`);
    assert.equal(placeholders(vi[key]), placeholders(en[key]), `placeholders differ: ${key}`);
  }
});

test("CPU-only laptop: small models are usable, 14B is slow, 32B does not fit", () => {
  const small = estimate(model("qwen3:4b"), laptop);
  assert.equal(small.fit, "cpu");
  assert.ok(small.tps > 6 && small.tps < 15, `4b tps ${small.tps}`);
  assert.equal(estimate(model("qwen3:14b"), laptop).speed, "slow");
  assert.equal(estimate(model("qwen3:32b"), laptop).fit, "no");
});

test("a 12 GB GPU runs 8B models fast and splits bigger ones", () => {
  const e8 = estimate(model("qwen3:8b"), gamer);
  assert.equal(e8.fit, "gpu");
  assert.ok(e8.tps > 40, `8b tps ${e8.tps}`);
  assert.equal(estimate(model("qwen3:32b"), gamer).fit, "split");
});

test("MoE models are estimated by their active parameters", () => {
  const moe = estimate(model("qwen3:30b"), { ...gamer, gpus: [] });
  const dense = estimate(model("qwen3:32b"), { ...gamer, gpus: [] });
  assert.ok(moe.tps > dense.tps * 3);
});

test("recommendations fit the machine and prefer Vietnamese-capable models when asked", () => {
  const recs = recommend(laptop, true);
  const chat = recs.find((r) => r.use === "chat")!;
  assert.ok(chat.estimate.tps >= 8, "chat pick is usable");
  assert.ok(chat.estimate.model.vi);
  for (const r of recs) assert.notEqual(r.estimate.fit, "no");
});
