const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");
const engine = require("../../dist/services/ats/ATSEvaluationEngine");
const { OpenAIScoringProvider } = require("../../dist/services/ats/OpenAIScoringProvider");
const { createResumeExtractor } = require("../../dist/services/ats/ResumeExtractor");
const { ATSEvaluationService } = require("../../dist/services/ats/ATSEvaluationService");
const { ATSEvaluationWorker, mongoEvaluationQueue } = require("../../dist/services/ats/ATSEvaluationWorker");
const { AutomatedEvaluation } = require("../../dist/models/AutomatedEvaluation");
const { Application } = require("../../dist/models/Application");
const { SubteamConfig } = require("../../dist/models/SubteamConfig");
const { resume, makeResult: result } = require("../helpers/ats-fixtures");

test("production transport is mocked; strict schema and conservative spend boundary enforced", async () => {
  const config = { apiKey: "not-a-credential", model: "club-model", maxOutputTokens: 1000, maxCostUsdPerEvaluation: 1, totalBudgetUsd: 2, inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
  let calls = 0;
  const transport = async (_, body) => {
    calls++;
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.instructions, engine.SCORING_INSTRUCTIONS);
    return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result(60)) }] }] };
  };
  const provider = new OpenAIScoringProvider(config, { reserve: async () => true }, transport);
  assert.equal((await provider.score({ resumeText: resume, jobTitle: "Engineer" })).categories[0].score, 60);
  await assert.rejects(new OpenAIScoringProvider(config, { reserve: async () => false }, transport).score({ resumeText: resume, jobTitle: "Engineer" }), /budget/);
  assert.equal(calls, 1);
  await assert.rejects(new OpenAIScoringProvider(config, { reserve: async () => true }, async () => { throw new Error(resume); }).score({ resumeText: resume, jobTitle: "Engineer" }), error => !error.message.includes(resume));
});

test("privacy boundary drops identity and protected lines and rejects prohibited explanations", async () => {
  const safe = engine.prepareResumeEvidence(`Jane Example\nEmail: jane@example.test\nNationality: Example\nEducation: Prestigious University\n${resume}`);
  assert.equal(safe, resume);
  const prohibited = result(60); prohibited.explanation = "The applicant is young and attended an elite school.";
  await assert.rejects(engine.scoreExtractedResume({ resumeText: resume, jobTitle: "Engineer" }, new engine.MockScoringProvider(prohibited)), /prohibited/);
  const named = result(60); named.explanation = "Jane Example contributed useful work.";
  await assert.rejects(engine.scoreExtractedResume({ resumeText: resume, jobTitle: "Engineer" }, new engine.MockScoringProvider(named)), /identifying/);
  assert.throws(() => engine.prepareResumeEvidence("Jane Example\n".repeat(20)), /too little/);
});

test("runtime cannot register live dependencies in normal development or tests", () => {
  const { productionEvaluationDependencies } = require("../../dist/services/ats/ATSEvaluationSetup");
  assert.deepEqual(productionEvaluationDependencies(), {});
  const { readClubScoringConfig } = require("../../dist/services/ats/ATSEvaluationSetup");
  assert.equal(readClubScoringConfig({ ATS_AI_SCORING_ENABLED: "true", OPENAI_API_KEY: "not-a-credential", ATS_AI_MODEL: "club-model", ATS_AI_MAX_OUTPUT_TOKENS: "1000", ATS_AI_MAX_COST_USD_PER_EVALUATION: "1" }), null);
});

test("extractor uses only owned PDF objects, bounded bytes, and mock parsing", async () => {
  const id = "synthetic-applicant";
  const bytes = Buffer.from("%PDF-synthetic-test");
  const object = { contentType: "application/pdf", size: bytes.length, body: (async function* () { yield bytes; })() };
  let reads = 0;
  const extract = createResumeExtractor(async () => ({ id, key: `resumes/${id}.pdf` }), async () => { reads++; return object; }, async () => resume);
  assert.equal(await extract(id), resume);
  await assert.rejects(createResumeExtractor(async () => ({ id: "other", key: "other.pdf" }), async () => { reads++; return object; })(id), /unsupported/);
  assert.equal(reads, 1);
  await assert.rejects(createResumeExtractor(async () => ({ id, key: `resumes/${id}.pdf` }), async () => ({ ...object, contentType: "text/plain" }))(id), /unsupported/);
  await assert.rejects(createResumeExtractor(async () => ({ id, key: `resumes/${id}.pdf` }), async () => ({ ...object, body: (async function* () { yield bytes; })() }), async () => "")(id), /unreadable/);
});

test("one application queues every title, computes different scores, and checks changed content", async t => {
  const id = new Types.ObjectId(), applicantId = new Types.ObjectId();
  const app = { _id: id, applicantId, teamPk: "team", rolePreferences: [{ role: "Frontend Engineer", subteamPk: "a" }, { role: "Backend Engineer", subteamPk: "b" }], stars: 4, notes: "Human feedback" };
  const records = app.rolePreferences.map(p => {
    const record = new AutomatedEvaluation({ applicationId: id, applicantId, teamPk: "team", subteamPk: p.subteamPk, jobTitle: p.role, status: "failed", rubricVersion: engine.RUBRIC_VERSION, promptVersion: engine.PROMPT_VERSION, modelVersion: "mock-test-only" });
    record.save = async () => record; return record;
  });
  t.mock.method(Application, "findOne", () => ({ exec: async () => app }));
  t.mock.method(SubteamConfig, "findOne", () => ({ exec: async () => ({ roles: app.rolePreferences.map(p => p.role) }) }));
  t.mock.method(AutomatedEvaluation, "findOne", filter => ({ exec: async () => records.find(r => r.jobTitle === filter.jobTitle) }));
  let text = resume, calls = 0;
  const service = new ATSEvaluationService({ setStatus() {}, setHeader() {} }, { enabled: true, extractResumeText: async () => text,
    provider: new engine.MockScoringProvider(input => { calls++; return result(input.jobTitle.startsWith("Frontend") ? 80 : 40); }) });
  assert.equal((await service.queueAll("team", String(id))).results.length, 2);
  for (const record of records) await service.process(record);
  assert.deepEqual(records.map(r => r.overallScore), [80, 40]);
  await service.queueAll("team", String(id)); assert.equal(calls, 2);
  text += " Built another tested application.";
  await service.queue("team", String(id), { subteamPk: "a", jobTitle: "Frontend Engineer" });
  assert.equal(records[0].status, "queued");
  await service.process(records[0]); assert.equal(calls, 3);
  assert.equal(app.stars, 4); assert.equal(app.notes, "Human feedback");
});

test("worker atomically recovers an expired lease and fences writes; attempts are bounded", async t => {
  const record = new AutomatedEvaluation({ applicantId: new Types.ObjectId(), applicationId: new Types.ObjectId(), teamPk: "team", subteamPk: "sub", jobTitle: "Engineer", status: "processing", attempts: 1, leaseToken: "expired", leaseUntil: new Date(0), rubricVersion: engine.RUBRIC_VERSION, promptVersion: engine.PROMPT_VERSION, modelVersion: "mock-test-only" });
  let exhausted = false;
  t.mock.method(AutomatedEvaluation, "updateMany", (filter, update) => ({ exec: async () => {
    assert.equal(filter.attempts.$gte, 3);
    if (record.attempts >= 3) { exhausted = true; record.status = update.$set.status; }
  } }));
  t.mock.method(AutomatedEvaluation, "findOneAndUpdate", (filter, update) => ({ exec: async () => {
    if (filter.$and) {
      assert.ok(filter.$and[1].$or[1].leaseUntil.$lte);
      if (record.attempts >= 3 || record.status !== "processing") return null;
      Object.assign(record, update.$set); record.attempts++; return record;
    }
    assert.equal(filter.leaseToken, record.leaseToken);
    assert.ok(filter.leaseUntil.$gt);
    Object.assign(record, update.$set); return record;
  } }));
  const worker = new ATSEvaluationWorker({ enabled: true, provider: new engine.MockScoringProvider(result(60)), extractResumeText: async () => resume }, mongoEvaluationQueue);
  assert.equal(await worker.tick(), true); assert.equal(record.status, "scored"); assert.equal(record.attempts, 2);
  record.status = "processing"; record.attempts = 3; record.leaseUntil = new Date(0);
  assert.equal(await worker.tick(), false); assert.equal(exhausted, true); assert.equal(record.status, "failed");
  assert.equal(await new ATSEvaluationWorker({}).tick(), false);
});
