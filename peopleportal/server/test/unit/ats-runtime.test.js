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
