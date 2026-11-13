exports.resume = "Built a React application with TypeScript, wrote accessibility tests, and reduced page load time by 30 percent through measured caching changes.";
exports.makeCategories = (score = 60) => ["skills", "projects", "experience", "outcomes"].map(key => ({
  key, score, explanation: "Demonstrated relevant work.", evidence: ["React application"],
}));
exports.makeResult = (score = 60) => ({
  inferredJobFocus: "Software development", explanation: "Demonstrated relevant work.",
  categories: exports.makeCategories(score),
});
exports.makeDependencies = (score = 60) => {
  const { MockScoringProvider } = require("../../dist/services/ats/ATSEvaluationEngine");
  return { enabled: true, provider: new MockScoringProvider(exports.makeResult(score)), extractResumeText: async () => exports.resume };
};
