const assert = require("node:assert/strict");
const { AutomatedEvaluation } = require("../../dist/models/AutomatedEvaluation");
const { Application } = require("../../dist/models/Application");
const { SubteamConfig } = require("../../dist/models/SubteamConfig");

// Query-aware contract double, not a substitute for Mongo unique-index/concurrency staging tests.
function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$and") return value.every(part => matches(record, part));
    if (key === "$or") return value.some(part => matches(record, part));
    const actual = record[key];
    if (value && typeof value === "object" && !(value instanceof Date) && !value._bsontype) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === "$exists") return (actual !== undefined) === expected;
        if (op === "$gt") return actual > expected;
        if (op === "$gte") return actual >= expected;
        if (op === "$lte") return actual <= expected;
        if (op === "$lt") return actual < expected;
        if (op === "$in") return expected.includes(actual);
        assert.fail(`unsupported mock operator ${op}`);
      });
    }
    return String(actual) === String(value);
  });
}
function update(record, change, inserting = false) {
  Object.assign(record, inserting ? change.$setOnInsert : {}, change.$set);
  for (const key of Object.keys(change.$unset || {})) delete record[key];
  for (const [key, value] of Object.entries(change.$inc || {})) record[key] = (record[key] || 0) + value;
}
exports.memoryModels = (t, apps, config, initial = []) => {
  const records = initial.map(record => new AutomatedEvaluation(record).toObject());
  // Preserve absent raw revision fields; hydrate applies defaults only to the returned snapshot.
  const clone = raw => raw ? { ...raw, categories: raw.categories?.map(category => ({ ...category })) } : null;
  const doc = raw => raw ? AutomatedEvaluation.hydrate(clone(raw)) : null;
  const query = action => ({ exec: async () => action() });
  t.mock.method(Application, "findOne", filter => query(() => apps.find(app => matches(app, filter)) || null));
  t.mock.method(SubteamConfig, "findOne", () => query(() => config));
  t.mock.method(AutomatedEvaluation, "findOne", filter => query(() => doc(records.find(record => matches(record, filter)))));
  t.mock.method(AutomatedEvaluation, "findOneAndUpdate", (filter, change, options = {}) => query(() => {
    let raw = records.find(record => matches(record, filter));
    if (!raw && options.upsert) {
      const identity = { applicationId: filter.applicationId, subteamPk: filter.subteamPk, jobTitle: filter.jobTitle };
      if (records.some(record => matches(record, identity))) throw Object.assign(new Error("duplicate"), { code: 11000 });
      raw = new AutomatedEvaluation(identity).toObject(); update(raw, change, true); records.push(raw);
    } else if (raw) update(raw, change);
    return doc(raw);
  }));
  t.mock.method(AutomatedEvaluation, "updateOne", (filter, change) => query(() => {
    const raw = records.find(record => matches(record, filter)); if (raw) update(raw, change);
    return { matchedCount: raw ? 1 : 0 };
  }));
  t.mock.method(AutomatedEvaluation, "updateMany", (filter, change) => query(() => {
    for (const raw of records.filter(record => matches(record, filter))) update(raw, change);
    return {};
  }));
  return { records, doc, matches };
};
