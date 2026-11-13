const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createResumeExtractor } = require("../../dist/services/ats/ResumeExtractor");
const { resume } = require("../helpers/ats-fixtures");

test("application extractor verifies exact snapshot ownership and byte hash before parsing", async () => {
  const bytes = Buffer.from("%PDF-synthetic");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let source = { id: "application", applicantId: "applicant", key: "resumes/applicant/application.pdf", hash };
  let parsed = 0;
  const extract = createResumeExtractor(async () => source, async () => ({ contentType: "application/pdf", size: bytes.length,
    body: (async function* () { yield bytes; })() }), async () => { parsed++; return resume; });
  assert.equal(await extract("application"), resume);
  source = { ...source, key: "resumes/applicant/other.pdf" };
  await assert.rejects(extract("application"));
  source = { ...source, key: "resumes/applicant/application.pdf", hash: "0".repeat(64) };
  await assert.rejects(extract("application"));
  assert.equal(parsed, 1);
});

test("legacy stub never creates or returns genuine assessments", async () => {
  const { scoreApplication, getScoresForApplication } = require("../../dist/scoring/scoreApplication");
  const app = { resumeKey: "synthetic", resumeHash: "synthetic", rolePreferences: [{ role: "Engineer", subteamPk: "sub" }] };
  await scoreApplication(app);
  assert.deepEqual(await getScoresForApplication(app), []);
});

test("transaction preserves submitted snapshot fields and never deletes on ambiguous commit", async t => {
  const { Types } = require("mongoose");
  const { ATSApplicantService } = require("../../dist/services/ats/ATSApplicantService");
  const { Applicant } = require("../../dist/models/Applicant");
  const { Application } = require("../../dist/models/Application");
  const storage = require("../../dist/utils/s3-validation");
  const helpers = require("../../dist/services/ats/ATSHelpers");
  const { s3Client } = require("../../dist/clients/AWSClient/S3Client");
  let saved;
  t.mock.method(storage, "copyS3Object", async () => {});
  t.mock.method(storage, "getS3ObjectSha256", async () => "a".repeat(64));
  t.mock.method(helpers, "verifyApplicantResume", async () => undefined);
  t.mock.method(s3Client, "send", async () => assert.fail("must not delete uncertain snapshot"));
  t.mock.method(Applicant, "findByIdAndUpdate", () => ({ exec: async () => ({}) }));
  t.mock.method(Application, "create", async records => { saved = records[0]; return records; });
  t.mock.method(Applicant.db, "transaction", async action => { await action({}); throw new Error("unknown commit outcome"); });
  const id = new Types.ObjectId();
  const service = new ATSApplicantService({ setStatus() {}, setHeader() {} }, {});
  await assert.rejects(service.createAndLinkApplication({ _id: id }, { teamPk: "team", profile: { resumeUrl: `resumes/${id}.pdf` },
    rolePreferences: [{ role: "Engineer", subteamPk: "sub" }], responses: {} }, null, "Synthetic Person"));
  assert.equal(saved.resumeKey, `resumes/${id}/${saved._id}.pdf`);
  assert.equal(saved.resumeHash, "a".repeat(64));
  assert.equal(saved.profileSnapshot.get("submittedFullName"), "Synthetic Person");
});
