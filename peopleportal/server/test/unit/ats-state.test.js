const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");
const { memoryModels } = require("../helpers/ats-memory-models");
const { makeDependencies, makeResult } = require("../helpers/ats-fixtures");
const { ATSEvaluationService } = require("../../dist/services/ats/ATSEvaluationService");
const { ATSEvaluationWorker } = require("../../dist/services/ats/ATSEvaluationWorker");
const { ATSEvaluationProcessor } = require("../../dist/services/ats/ATSEvaluationProcessor");

function fixture(t) {
  const app = { _id: new Types.ObjectId(), applicantId: new Types.ObjectId(), teamPk: "team", resumeHash: "a".repeat(64), stars: 4, notes: "Human note",
    rolePreferences: [{ subteamPk: "sub", role: "Frontend Engineer" }, { subteamPk: "sub", role: "Backend Engineer" }] };
  app.resumeKey = `resumes/${app.applicantId}/${app._id}.pdf`;
  const config = { roles: app.rolePreferences.map(p => p.role), importantRequirementsByRole: [] };
  const memory = memoryModels(t, [app], config);
  const deps = makeDependencies(); let status;
  const service = new ATSEvaluationService({ setStatus(value) { status = value; }, setHeader() {} }, deps);
  const request = { subteamPk: "sub", jobTitle: "Frontend Engineer" };
  return { app, config, memory, deps, service, request, get status() { return status; } };
}

test("bulk queues selected titles, computes different scores and preserves human feedback", async t => {
  const f = fixture(t); let calls = 0;
  f.deps.provider.score = async input => { calls++; return makeResult(input.jobTitle.startsWith("Frontend") ? 80 : 40); };
  const bulk = await f.service.queueAll("team", String(f.app._id)); assert.equal(bulk.results.length, 2);
  const worker = new ATSEvaluationWorker(f.deps); await worker.tick(); await worker.tick();
  assert.deepEqual(f.memory.records.map(r => r.overallScore), [80, 40]);
  await f.service.queueAll("team", String(f.app._id)); assert.equal(calls, 2);
  assert.equal(f.app.stars, 4); assert.equal(f.app.notes, "Human note");
  f.config.importantRequirementsByRole = [{ role: "Frontend Engineer", text: "React" }];
  assert.equal((await f.service.get("team", String(f.app._id), f.request)).evaluation.status, "stale");
  await f.service.queue("team", String(f.app._id), f.request); await worker.tick(); assert.equal(calls, 3);
  f.app.resumeHash = "b".repeat(64);
  assert.equal((await f.service.get("team", String(f.app._id), f.request)).evaluation.status, "stale");
});

for (const invalidation of ["token", "expiry", "status", "context"]) {
  test(`processor cannot publish after losing ${invalidation}`, async t => {
    const f = fixture(t); await f.service.queue("team", String(f.app._id), f.request);
    f.deps.provider.score = async () => {
      const record = f.memory.records[0];
      if (invalidation === "token") record.leaseToken = "other-worker";
      if (invalidation === "expiry") record.leaseUntil = new Date(0);
      if (invalidation === "status") record.status = "stale";
      if (invalidation === "context") record.contextKey = "changed";
      return makeResult(90);
    };
    await new ATSEvaluationWorker(f.deps).tick();
    assert.equal(f.memory.records[0].overallScore, undefined);
  });
}

test("processor refreshes queued versions and refuses requirements changed during scoring", async t => {
  const f = fixture(t); await f.service.queue("team", String(f.app._id), f.request);
  f.memory.records[0].modelVersion = "old";
  f.deps.provider.score = async () => { f.config.importantRequirementsByRole = [{ role: "Frontend Engineer", text: "Python" }]; return makeResult(90); };
  await new ATSEvaluationWorker(f.deps).tick();
  assert.equal(f.memory.records[0].status, "stale");
  assert.equal(f.memory.records[0].modelVersion, f.deps.provider.modelVersion);
  assert.equal(f.memory.records[0].overallScore, undefined);
});

test("failure is safe, retries capped, changed context starts a fresh cycle", async t => {
  const f = fixture(t); await f.service.queue("team", String(f.app._id), f.request);
  f.deps.provider.score = async () => { throw new Error("private synthetic provider body"); };
  const worker = new ATSEvaluationWorker(f.deps); await worker.tick();
  assert.equal(f.memory.records[0].status, "failed");
  assert.ok(!f.memory.records[0].failureMessage.includes("private"));
  f.memory.records[0].attempts = 3;
  assert.equal((await f.service.queue("team", String(f.app._id), f.request, true)).error, "RetryLimit");
  f.app.resumeHash = "c".repeat(64);
  await f.service.queue("team", String(f.app._id), f.request, true);
  assert.equal(f.memory.records[0].attempts, 0);
});

test("concurrent queue creation is idempotent and interrupted work is recovered", async t => {
  const f = fixture(t);
  await Promise.all([f.service.queue("team", String(f.app._id), f.request), f.service.queue("team", String(f.app._id), f.request)]);
  assert.equal(f.memory.records.length, 1);
  Object.assign(f.memory.records[0], { status: "processing", leaseToken: "old", leaseUntil: new Date(0), attempts: 1 });
  await new ATSEvaluationWorker(f.deps).tick();
  assert.equal(f.memory.records[0].status, "scored"); assert.equal(f.memory.records[0].attempts, 2);
});

test("legacy missing revision is invalidated safely despite hydrate defaults", async t => {
  const f = fixture(t); await f.service.queue("team", String(f.app._id), f.request);
  Object.assign(f.memory.records[0], { status: "scored", overallScore: 90 });
  delete f.memory.records[0].revision; delete f.memory.records[0].contextKey;
  const result = await f.service.get("team", String(f.app._id), f.request);
  assert.equal(result.evaluation.status, "stale");
  assert.equal(f.memory.records[0].status, "stale");
});

test("a newly discovered context during claim starts its own bounded attempt cycle", async t => {
  const f = fixture(t); await f.service.queue("team", String(f.app._id), f.request);
  Object.assign(f.memory.records[0], { contextKey: "previous-context", attempts: 2 });
  f.deps.provider.score = async () => { throw new Error("synthetic failure"); };
  await new ATSEvaluationWorker(f.deps).tick();
  assert.equal(f.memory.records[0].attempts, 1);
  assert.equal(f.memory.records[0].status, "failed");
});
