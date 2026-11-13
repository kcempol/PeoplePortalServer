const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");
const { Application } = require("../../dist/models/Application");
const { AutomatedEvaluation } = require("../../dist/models/AutomatedEvaluation");
const { SubteamConfig } = require("../../dist/models/SubteamConfig");
const { EvaluationReconciliationWorker, RECONCILIATION_BATCH_SIZE } = require("../../dist/services/ats/EvaluationReconciliationWorker");
const { makeDependencies } = require("../helpers/ats-fixtures");

function fixture(t, count = 1) {
  const apps = Array.from({ length: count }, () => ({ _id: new Types.ObjectId(), applicantId: new Types.ObjectId(), teamPk: "team",
    rolePreferences: [{ subteamPk: "sub", role: "Frontend Engineer" }, { subteamPk: "sub", role: "Backend Engineer" }], stars: 4, notes: "Human feedback" }));
  const records = new Map();
  const key = filter => `${filter.applicationId}:${filter.subteamPk}:${filter.jobTitle}`;
  let failures = 0, writes = 0;
  t.mock.method(Application, "find", filter => {
    const query = { select() { return query; }, sort() { return query; }, limit(n) {
      assert.equal(n, RECONCILIATION_BATCH_SIZE); return query;
    }, exec: async () => apps.filter(app => !filter._id || ((!filter._id.$gt || String(app._id) > String(filter._id.$gt)) &&
      (!filter._id.$lte || String(app._id) <= String(filter._id.$lte)))).slice(0, RECONCILIATION_BATCH_SIZE) };
    return query;
  });
  t.mock.method(Application, "findOne", () => {
    const query = { select() { return query; }, sort() { return query; }, exec: async () => apps.at(-1) || null }; return query;
  });
  t.mock.method(AutomatedEvaluation, "find", filter => {
    const query = { select() { return query; }, lean() { return query; }, exec: async () => [...records.entries()].map(([key, record]) => {
      const [applicationId, subteamPk, ...role] = key.split(":"); return { ...record, applicationId, subteamPk, jobTitle: role.join(":") };
    }).filter(record => filter.applicationId.$in.map(String).includes(String(record.applicationId))) }; return query;
  });
  t.mock.method(AutomatedEvaluation, "findOne", filter => {
    const query = { select() { return query; }, exec: async () => records.get(key(filter)) || null }; return query;
  });
  t.mock.method(SubteamConfig, "findOne", () => ({ exec: async () => ({ importantRequirementsByRole: [] }) }));
  t.mock.method(AutomatedEvaluation, "updateOne", (filter, update, options) => ({ exec: async () => {
    writes++;
    assert.equal(options.timestamps, false);
    if (failures > 0) { failures--; throw new Error("synthetic queue failure"); }
    if (!records.has(key(filter))) records.set(key(filter), { ...update.$setOnInsert });
  } }));
  return { apps, records, key, failNext(n) { failures = n; }, get writes() { return writes; } };
}

test("reconciliation queues missing titles and preserves every existing status and human feedback", async t => {
  const f = fixture(t, 5);
  for (const [i, status] of ["queued", "processing", "scored", "failed", "stale"].entries()) {
    f.records.set(f.key({ applicationId: f.apps[i]._id, subteamPk: "sub", jobTitle: "Frontend Engineer" }), { status, attempts: 3 });
  }
  const before = [...f.records.values()].map(record => ({ ...record }));
  const worker = new EvaluationReconciliationWorker(makeDependencies());
  await worker.tick();
  assert.equal(f.records.size, 10);
  assert.equal(f.writes, 5);
  assert.deepEqual([...f.records.values()].slice(0, 5), before);
  await worker.tick();
  assert.equal(f.writes, 5);
  assert.ok(f.apps.every(app => app.stars === 4 && app.notes === "Human feedback"));
});

test("partial queue failure recovers next pass", async t => {
  const f = fixture(t);
  f.failNext(1);
  const worker = new EvaluationReconciliationWorker(makeDependencies());
  await worker.tick(); assert.equal(f.records.size, 1);
  await worker.tick(); assert.equal(f.records.size, 2);
});

test("multiple reconcilers racing create one record per title", async t => {
  const f = fixture(t);
  await Promise.all([new EvaluationReconciliationWorker(makeDependencies()).tick(), new EvaluationReconciliationWorker(makeDependencies()).tick()]);
  assert.equal(f.records.size, 2);
});

test("bounded scan progresses beyond first batch and revisits earlier failures", async t => {
  const f = fixture(t, RECONCILIATION_BATCH_SIZE + 1);
  const worker = new EvaluationReconciliationWorker(makeDependencies());
  f.failNext(1);
  await worker.tick(); assert.equal(f.records.size, RECONCILIATION_BATCH_SIZE * 2 - 1);
  await worker.tick(); assert.equal(f.records.size, f.apps.length * 2 - 1);
  await worker.tick(); assert.equal(f.records.size, f.apps.length * 2);
});

test("disabled reconciler accesses no models", async t => {
  t.mock.method(Application, "find", () => assert.fail("disabled worker accessed database"));
  await new EvaluationReconciliationWorker({}).tick();
  new EvaluationReconciliationWorker({}).start()();
});

test("new arrivals cannot prevent sweep wrap and retry of earlier failures", async t => {
  const f = fixture(t, RECONCILIATION_BATCH_SIZE);
  f.failNext(1);
  const worker = new EvaluationReconciliationWorker(makeDependencies());
  await worker.tick();
  const original = f.apps[0];
  f.apps.push({ ...original, _id: new Types.ObjectId() });
  await worker.tick();
  assert.equal(f.records.size, RECONCILIATION_BATCH_SIZE * 2); // Earlier failure repaired before new arrival.
  await worker.tick();
  assert.equal(f.records.size, RECONCILIATION_BATCH_SIZE * 2 + 2);
});

test("production registration is disabled for development, test and incomplete production config", t => {
  const { startProductionEvaluationReconciler } = require("../../dist/services/ats/ATSEvaluationSetup");
  t.mock.method(EvaluationReconciliationWorker.prototype, "start", () => assert.fail("must not register"));
  const oldMode = process.env.NODE_ENV, oldConfirmed = process.env.ATS_AI_CLUB_CONFIRMED;
  try {
    delete process.env.ATS_AI_CLUB_CONFIRMED;
    for (const mode of ["development", "test", "production"]) {
      process.env.NODE_ENV = mode;
      startProductionEvaluationReconciler()();
    }
  } finally {
    if (oldMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldMode;
    if (oldConfirmed === undefined) delete process.env.ATS_AI_CLUB_CONFIRMED; else process.env.ATS_AI_CLUB_CONFIRMED = oldConfirmed;
  }
});
