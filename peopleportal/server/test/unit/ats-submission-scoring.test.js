const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");
const { queueSubmittedApplication } = require("../../dist/services/ats/SubmissionEvaluationQueue");
const { ATSApplicantService } = require("../../dist/services/ats/ATSApplicantService");
const { AutomatedEvaluation } = require("../../dist/models/AutomatedEvaluation");
const { Applicant } = require("../../dist/models/Applicant");
const { Application } = require("../../dist/models/Application");
const { SubteamConfig } = require("../../dist/models/SubteamConfig");
const { TeamRecruitingStatus } = require("../../dist/models/TeamRecruitingStatus");
const helpers = require("../../dist/services/ats/ATSHelpers");
const { makeDependencies } = require("../helpers/ats-fixtures");

function application() {
  return { _id: new Types.ObjectId(), applicantId: new Types.ObjectId(), teamPk: "team",
    rolePreferences: [{ subteamPk: "sub", role: "Frontend Engineer" }, { subteamPk: "sub", role: "Backend Engineer" }],
    stars: 4, notes: "Human feedback" };
}

test("submission queues every title without extraction/scoring; repeated delivery preserves records", async t => {
  const app = application(), records = new Map();
  const deps = makeDependencies();
  deps.extractResumeText = async () => { assert.fail("must not extract inline"); };
  deps.provider.score = async () => { assert.fail("must not score inline"); };
  t.mock.method(SubteamConfig, "findOne", () => ({ exec: async () => ({ importantRequirementsByRole: [{ role: "Frontend Engineer", text: "React" }] }) }));
  t.mock.method(AutomatedEvaluation, "updateOne", (filter, update, options) => ({ exec: async () => {
    assert.equal(options.upsert, true);
    assert.equal(String(filter.applicationId), String(app._id));
    if (!records.has(filter.jobTitle)) records.set(filter.jobTitle, { ...update.$setOnInsert });
  } }));
  await queueSubmittedApplication(app, deps);
  assert.equal(records.size, 2);
  assert.equal(records.get("Frontend Engineer").importantRequirements, "React");
  assert.equal(records.get("Backend Engineer").status, "queued");
  records.get("Frontend Engineer").status = "scored";
  await queueSubmittedApplication(app, deps);
  assert.equal(records.get("Frontend Engineer").status, "scored");
  assert.equal(app.stars, 4);
  assert.equal(app.notes, "Human feedback");
});

test("disabled scoring queues nothing", async t => {
  t.mock.method(SubteamConfig, "findOne", () => assert.fail("disabled queue accessed model"));
  await queueSubmittedApplication(application(), {});
});

test("one title queue failure does not stop other titles", async t => {
  let writes = 0;
  t.mock.method(SubteamConfig, "findOne", () => ({ exec: async () => null }));
  t.mock.method(AutomatedEvaluation, "updateOne", () => ({ exec: async () => {
    writes++;
    if (writes === 1) throw new Error("synthetic queue failure");
  } }));
  await queueSubmittedApplication(application(), makeDependencies());
  assert.equal(writes, 2);
});

async function submissionFixture(t, queue, commitError = false) {
  const app = application();
  const events = [];
  t.mock.method(TeamRecruitingStatus, "findOne", () => ({ exec: async () => ({ isRecruiting: true, recruitingSubteamPks: ["sub"] }) }));
  t.mock.method(Applicant, "findOne", () => ({ exec: async () => ({ _id: app.applicantId }) }));
  t.mock.method(Application, "findOne", () => ({ exec: async () => null }));
  t.mock.method(helpers, "validateApplicantProfile", () => undefined);
  t.mock.method(helpers, "validateApplicationResponses", () => undefined);
  t.mock.method(helpers, "verifyApplicantResume", async () => undefined);
  let status;
  const service = new ATSApplicantService({ setStatus(value) { status = value; }, setHeader() {} },
    { getGroupInfo: async () => ({ name: "Team", attributes: {} }) }, async saved => {
      assert.equal(saved, app);
      assert.deepEqual(events, ["committed"]);
      events.push("queued");
      await queue();
    });
  service.validateRolePreferences = async () => undefined;
  service.collectRoleQuestions = async () => new Set();
  service.findInternalMemberPk = async () => null;
  service.createAndLinkApplication = async () => {
    if (commitError) throw new Error("synthetic transaction failure");
    events.push("committed");
    return app;
  };
  const result = await service.applyToTeam({ teamPk: "team", rolePreferences: app.rolePreferences, profile: {}, responses: {} },
    { session: { tempsession: { user: { email: "synthetic@example.test" } } } });
  return { result, status, events };
}

test("successful submission triggers queue only after commit", async t => {
  const { result, events } = await submissionFixture(t, async () => {});
  assert.equal(result.message, "Application submitted successfully");
  assert.deepEqual(events, ["committed", "queued"]);
});

test("queue failure preserves successful submission response", async t => {
  const { result } = await submissionFixture(t, async () => { throw new Error("synthetic queue failure"); });
  assert.equal(result.message, "Application submitted successfully");
  assert.equal(result.error, undefined);
});

test("failed application transaction never triggers scoring", async t => {
  t.mock.method(console, "error", () => {});
  const { result, events } = await submissionFixture(t, async () => assert.fail("must not queue"), true);
  assert.equal(result.error, "ServerError");
  assert.deepEqual(events, []);
});

test("accepted application succeeds with disabled automatic scoring", async t => {
  const { result } = await submissionFixture(t, async () => queueSubmittedApplication(application(), {}));
  assert.equal(result.message, "Application submitted successfully");
});

for (const failedWrites of [1, 2]) {
  test(`accepted application succeeds when ${failedWrites} queue writes fail`, async t => {
    let writes = 0;
    t.mock.method(SubteamConfig, "findOne", () => ({ exec: async () => null }));
    t.mock.method(AutomatedEvaluation, "updateOne", () => ({ exec: async () => {
      writes++;
      if (writes <= failedWrites) throw new Error("synthetic queue failure");
    } }));
    const { result } = await submissionFixture(t, async () => queueSubmittedApplication(application(), makeDependencies()));
    assert.equal(result.message, "Application submitted successfully");
    assert.equal(writes, 2);
  });
}
