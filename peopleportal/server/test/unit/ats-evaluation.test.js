const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { Types } = require("mongoose");
const { Application } = require("../../dist/models/Application");
const { SubteamConfig } = require("../../dist/models/SubteamConfig");
const { AutomatedEvaluation } = require("../../dist/models/AutomatedEvaluation");
const { ATSEvaluationService } = require("../../dist/services/ats/ATSEvaluationService");
const { readClubScoringConfig } = require("../../dist/services/ats/ATSEvaluationSetup");
const { MockScoringProvider, scoreExtractedResume, contentHash, isEvaluationStale, weightedScore } = require("../../dist/services/ats/ATSEvaluationEngine");

const resume = "Built a React application with TypeScript, wrote accessibility tests, and reduced page load time by 30 percent through measured caching changes.";
const categories = [
  { key: "skills", score: 80, explanation: "Relevant skills", evidence: ["React application"] },
  { key: "projects", score: 60, explanation: "Built software", evidence: ["accessibility tests"] },
  { key: "experience", score: 50, explanation: "Transferable experience", evidence: ["React application"] },
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
    new MockScoringProvider({ inferredJobFocus: "UI", explanation: "Demonstrated relevant work.", categories: [{ ...categories[0], evidence: ["invented credential"] }, ...categories.slice(1)] })), /evidence could not be validated/);
});

test("title, requirements, content hash, or version changes make a score stale", () => {
  const saved = { jobTitle: "Frontend Engineer", importantRequirements: "React", resumeContentHash: "old", rubricVersion: "title-rubric-v1", modelVersion: "mock-test-only", promptVersion: "resume-evidence-v3" };
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
