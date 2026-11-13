const test = require("node:test");
const assert = require("node:assert/strict");
const { createShutdown } = require("../../dist/utils/graceful-shutdown");
test("shutdown stops accepting requests, drains workers and then closes resources once", async () => {
  const events = []; let release;
  const active = new Promise(resolve => { release = resolve; });
  const shutdown = createShutdown(async () => { events.push("http closed"); }, async () => { events.push("workers stopped"); await active; },
    async () => { events.push("resources closed"); });
  const first = shutdown(); const second = shutdown();
  assert.equal(first, second);
  await Promise.resolve(); assert.ok(!events.includes("resources closed"));
  release(); assert.equal(await first, true);
  assert.deepEqual(events, ["http closed", "workers stopped", "resources closed"]);
});
test("shutdown times out instead of hanging forever on interrupted work", async () => {
  const shutdown = createShutdown(async () => {}, () => new Promise(() => {}), async () => {}, 5);
  assert.equal(await shutdown(), false);
});

test("scoring worker stop waits for its active operation and exhaustion scans are bounded", async () => {
  const { ATSEvaluationWorker } = require("../../dist/services/ats/ATSEvaluationWorker");
  const { makeDependencies } = require("../helpers/ats-fixtures");
  let entered, release, exhaustions = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const worker = new ATSEvaluationWorker(makeDependencies(), { exhaust: async () => { exhaustions++; },
    claim: async () => { entered(); await blocked; return null; } });
  const stop = worker.start(); await started;
  let stopped = false; const drain = stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await drain; assert.equal(stopped, true);
  await worker.tick(); assert.equal(exhaustions, 1);
});
