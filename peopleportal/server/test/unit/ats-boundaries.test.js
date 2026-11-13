const test = require("node:test");
const assert = require("node:assert/strict");
const { resume, makeResult, makeDependencies } = require("../helpers/ats-fixtures");
const { prepareScoringInput, scoreExtractedResume, isEvaluationStale, RUBRIC_VERSION, PROMPT_VERSION } = require("../../dist/services/ats/ATSEvaluationEngine");

test("sanitized input removes identity headers before reaching a provider", async () => {
  const input = { resumeText: `Jane Example\nEmail: jane@example.test\n${resume}`, jobTitle: "Engineer" };
  assert.equal(prepareScoringInput(input).resumeText, resume);
  const deps = makeDependencies();
  deps.provider.score = async received => {
    assert.equal(received.resumeText, resume);
    return makeResult();
  };
  await scoreExtractedResume(input, deps.provider);
});

const saved = { jobTitle: "Engineer", importantRequirements: "React", resumeContentHash: "original", modelVersion: "mock-test-only", rubricVersion: RUBRIC_VERSION, promptVersion: PROMPT_VERSION };
for (const [field, replacement] of Object.entries({ jobTitle: "Backend Engineer", importantRequirements: "Python", resumeContentHash: "changed", modelVersion: "changed" })) {
  test(`${field} changes invalidate reuse independently`, () => {
    assert.equal(isEvaluationStale(saved, { ...saved, [field]: replacement }), true);
  });
}
test("unchanged scoring context remains reusable", () => {
  assert.equal(isEvaluationStale(saved, saved), false);
});

test("grouped privacy rules reject each prohibited information category", () => {
  const { prohibitedContent } = require("../../dist/services/ats/ResumePreparation");
  for (const text of ["person@example.test", "https://example.test", "555-555-1234", "123 Main Street", "elite school", "nationality", "introvert"]) {
    assert.equal(prohibitedContent(text), true, text);
  }
  assert.equal(prohibitedContent("Built a React application with measured outcomes."), false);
});
