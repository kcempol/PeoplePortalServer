const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { Types } = require("mongoose");
const { Application } = require("../../dist/models/Application");
const { SubteamConfig } = require("../../dist/models/SubteamConfig");
const { AutomatedEvaluation } = require("../../dist/models/AutomatedEvaluation");
const { ATSEvaluationService } = require("../../dist/services/ats/ATSEvaluationService");
const { readClubScoringConfig } = require("../../dist/services/ats/ATSEvaluationConfig");
const { MockScoringProvider, scoreExtractedResume, contentHash, isEvaluationStale, weightedScore } = require("../../dist/services/ats/ATSEvaluationEngine");

const resume = "Built a React application with TypeScript, wrote accessibility tests, and reduced page load time by 30 percent through measured caching changes.";
const categories = [
  { key: "skills", score: 80, explanation: "Relevant skills", evidence: ["React application"] },
  { key: "projects", score: 60, explanation: "Built software", evidence: ["accessibility tests"] },
  { key: "experience", score: 50, explanation: "Transferable experience", evidence: [] },
  { key: "outcomes", score: 90, explanation: "Measured outcome", evidence: ["reduced page load time by 30 percent"] },
];

test("server calculates weights and rejects invented evidence or unusable résumé text", async () => {
  assert.equal(weightedScore(categories), 68);
  const provider = new MockScoringProvider({ inferredJobFocus: "UI engineering", explanation: "Evidence matches the title.", categories });
  const scored = await scoreExtractedResume({ resumeText: resume, jobTitle: "Frontend Engineer" }, provider);
  assert.equal(scored.overallScore, 68);
  assert.equal(scored.resumeContentHash, contentHash(resume));
  await assert.rejects(scoreExtractedResume({ resumeText: "", jobTitle: "Frontend Engineer" }, provider), /No readable/);
  await assert.rejects(scoreExtractedResume({ resumeText: resume, jobTitle: "Frontend Engineer" },
    new MockScoringProvider({ inferredJobFocus: "UI", explanation: "", categories: [{ ...categories[0], evidence: ["invented credential"] }, ...categories.slice(1)] })), /evidence could not be validated/);
});

test("title, requirements, content hash, or version changes make a score stale", () => {
  const saved = { jobTitle: "Frontend Engineer", importantRequirements: "React", resumeContentHash: "old", rubricVersion: "title-rubric-v1", modelVersion: "mock-test-only", promptVersion: "resume-evidence-v2" };
  assert.equal(isEvaluationStale(saved, { jobTitle: saved.jobTitle, importantRequirements: "React", resumeContentHash: "old", modelVersion: saved.modelVersion }), false);
  assert.equal(isEvaluationStale(saved, { jobTitle: "Backend Engineer", importantRequirements: "React", modelVersion: saved.modelVersion }), true);
  assert.equal(isEvaluationStale(saved, { jobTitle: saved.jobTitle, importantRequirements: "Python", modelVersion: saved.modelVersion }), true);
  assert.equal(isEvaluationStale(saved, { jobTitle: saved.jobTitle, importantRequirements: "React", resumeContentHash: "new", modelVersion: saved.modelVersion }), true);
});

test("missing club configuration blocks queue before any database or provider access", async () => {
  assert.equal(readClubScoringConfig({}), null);
  assert.equal(readClubScoringConfig({ ATS_AI_SCORING_ENABLED: "true", ATS_AI_MODEL: "club-model" }), null);
  let status;
  const service = new ATSEvaluationService({ setStatus: value => { status = value; }, setHeader() {} });
  const result = await service.queue("team", "application", { subteamPk: "sub", jobTitle: "Engineer" });
  assert.equal(status, 503);
  assert.equal(result.error, "AIScoringNotConfigured");
});

test("generated evaluation routes use the existing hiring-access authorization", () => {
  const routes = fs.readFileSync(path.resolve(__dirname, "../../src/routes.ts"), "utf8");
  for (const method of ["getEvaluation", "queueEvaluation", "retryEvaluation", "queueAllEvaluations"]) {
    const start = routes.indexOf(`ATSController.prototype.${method}`);
    assert.ok(start > 0);
    assert.match(routes.slice(start - 350, start), /authenticateMiddleware\(\[\{"bindles":\["corp:hiringaccess"\]\}\]\)/);
  }
});

test("mocked models keep evaluations application-specific, retry failures, and preserve human feedback", async () => {
  const originals = { app: Application.findOne, config: SubteamConfig.findOne, evaluation: AutomatedEvaluation.findOne };
  const applicantId = new Types.ObjectId();
  const appIds = [new Types.ObjectId(), new Types.ObjectId()];
  const apps = appIds.map((_id, i) => ({ _id, applicantId, teamPk: "team", rolePreferences: [{ subteamPk: "sub", role: i ? "Backend Engineer" : "Frontend Engineer" }], stars: i + 2, notes: `Human note ${i}` }));
  const records = apps.map((app, i) => {
    const record = new AutomatedEvaluation({ applicantId, applicationId: app._id, teamPk: "team", subteamPk: "sub", jobTitle: app.rolePreferences[0].role, status: "queued", rubricVersion: "title-rubric-v1", modelVersion: "mock-test-only", promptVersion: "resume-evidence-v2" });
    record.save = async () => record;
    return record;
  });
  Application.findOne = filter => ({ exec: async () => apps.find(a => String(a._id) === String(filter._id) && a.teamPk === filter.teamPk) || null });
  const config = { roles: ["Frontend Engineer", "Backend Engineer"], importantRequirementsByRole: [{ role: "Frontend Engineer", text: "React" }] };
  SubteamConfig.findOne = () => ({ exec: async () => config });
  AutomatedEvaluation.findOne = filter => ({ exec: async () => records.find(r => String(r.applicationId) === String(filter.applicationId) && r.jobTitle === filter.jobTitle) || null });
  try {
    let calls = 0;
    let fail = true;
    const provider = new MockScoringProvider(input => {
      calls++;
      if (fail) throw new Error("private provider response containing résumé text");
      return { inferredJobFocus: input.jobTitle, explanation: "Relevant evidence.", categories: categories.map(c => ({ ...c, score: input.jobTitle.startsWith("Backend") ? 40 : c.score })) };
    });
    const service = new ATSEvaluationService({ setStatus() {}, setHeader() {} }, { enabled: true, provider, extractResumeText: async () => resume });
    await service.process(records[0]);
    assert.equal(records[0].status, "failed");
    assert.equal(records[0].failureCode, "SCORING_FAILED");
    assert.equal(records[0].failureMessage.includes("résumé text"), false);
    const retry = await service.queue("team", String(appIds[0]), { subteamPk: "sub", jobTitle: "Frontend Engineer" }, true);
    assert.equal(retry.evaluation.status, "queued");
    fail = false;
    await service.process(records[0]);
    await service.process(records[1]);
    assert.equal(records[0].overallScore, 68);
    assert.equal(records[1].overallScore, 40);
    assert.equal(calls, 3);
    config.importantRequirementsByRole[0].text = "Accessibility";
    const stale = await service.get("team", String(appIds[0]), { subteamPk: "sub", jobTitle: "Frontend Engineer" });
    assert.equal(stale.evaluation.status, "stale");
    const rescore = await service.queue("team", String(appIds[0]), { subteamPk: "sub", jobTitle: "Frontend Engineer" });
    assert.equal(rescore.evaluation.status, "queued");
    await service.process(records[0]);
    assert.equal(calls, 4, "changed requirements force a new provider call");
    records[0].status = "queued";
    await service.process(records[0]);
    assert.equal(calls, 4, "unchanged content does not call provider again");
    assert.equal(apps[0].stars, 2);
    assert.equal(apps[0].notes, "Human note 0");
    assert.equal(apps[1].stars, 3);
  } finally {
    Application.findOne = originals.app;
    SubteamConfig.findOne = originals.config;
    AutomatedEvaluation.findOne = originals.evaluation;
  }
});
