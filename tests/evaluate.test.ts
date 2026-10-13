import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { analyzeCase, defaultAnalysisLimits, type ModelAdapter } from "../src/analyzer.ts";
import { rulesVersion } from "../src/decision-rules.ts";
import { expectedSchema, scoreBaseline, scoreCase } from "../src/evaluate.ts";
import { loadCase } from "../src/load-case.ts";
import { resultSchema } from "../src/result-schema.ts";
import { rulesBaseline } from "../src/rules-baseline.ts";

async function setup(index: number) {
  const expected = expectedSchema.parse(JSON.parse(await readFile("evals/expected-outcomes.json", "utf8"))).cases[index];
  const bundle = await loadCase(`fixtures/patients/${expected.patient_folder}`);
  const response = await readFile(`fixtures/proposals/${expected.patient_folder}.json`, "utf8");
  const model: ModelAdapter = { provider: "test", model: "prepared", async generate() {
    return { text: response, completion: "complete", usage: null };
  } };
  const result = await analyzeCase(bundle, { runId: "test-evaluation", rulesVersion,
    limits: { ...defaultAnalysisLimits }, model });
  return { expected, bundle, result };
}

test("five prepared responses and the rules-only baseline pass the automated fixture checks", async () => {
  for (let index = 0; index < 5; index++) {
    const { expected, bundle, result } = await setup(index);
    assert.deepEqual(resultSchema.parse(result), result);
    assert.equal(scoreCase(result, expected, bundle).passed, true);
    assert.equal(scoreBaseline(rulesBaseline(bundle), expected).passed, true);
  }
});

test("scoring catches missing warnings, altered evidence, and wrong snapshots", async () => {
  const { expected, bundle, result } = await setup(4);
  assert.equal(result.outcome, "analyzed");
  if (result.outcome !== "analyzed") return;
  const noWarning = structuredClone(result);
  noWarning.warnings = noWarning.warnings.filter((w) => w.kind !== "instruction_attempt");
  assert.equal(scoreCase(noWarning, expected, bundle).passed, false);
  const badEvidence = structuredClone(result);
  badEvidence.facts[0].evidence[0].quote = "fabricated";
  assert.equal(scoreCase(badEvidence, expected, bundle).passed, false);
  const wrongSnapshot = structuredClone(result);
  wrongSnapshot.run.snapshotId = "0".repeat(64);
  assert.equal(scoreCase(wrongSnapshot, expected, bundle).passed, false);
});

test("scoring rejects incorrect statuses and lost correction history", async () => {
  const { expected, bundle, result } = await setup(2);
  if (result.outcome !== "analyzed") assert.fail("Expected a valid prepared response");
  const wrong = structuredClone(result);
  wrong.status = "needs_information";
  assert.equal(scoreCase(wrong, expected, bundle).passed, false);
  const lost = structuredClone(result);
  lost.corrections = [];
  assert.equal(scoreCase(lost, expected, bundle).passed, false);
});

test("baseline does not borrow a panel from the wrong case", async () => {
  const bundle = await loadCase("fixtures/patients/patient-005");
  const baseline = rulesBaseline(bundle);
  assert.deepEqual(baseline.missingFields, ["requested_panel"]);
  assert.equal(baseline.status, "needs_information");
  assert.ok(baseline.warningKinds.includes("unrelated_document"));
});


test("narrative conflict values must be supported by their own citations", async () => {
  const bundle = await loadCase("evals/final/patients/patient-202");
  const expected = expectedSchema.parse(JSON.parse(await readFile("evals/final/expected-outcomes.json", "utf8"))).cases[1];
  const result = resultSchema.parse(JSON.parse(await readFile("evals/records/final/patient-202.json", "utf8")));
  if (result.outcome !== "analyzed") assert.fail("Expected saved analysis");
  assert.equal(scoreCase(result, expected, bundle).passed, true);
  const conflict = result.issues.find((issue) => issue.field === "date_of_birth");
  if (conflict?.kind !== "conflicting") assert.fail("Expected DOB conflict");
  conflict.candidates[0].value = "1900-01-01";
  conflict.candidates[1].value = "1901-02-02";
  const score = scoreCase(result, expected, bundle);
  assert.ok("evidenceChecks" in score.checks);
  assert.equal(score.checks.evidenceChecks, false);
  assert.equal(scoreCase(result, expected, bundle).passed, false);
});


test("evaluation compares conflict values with independent expected answers", async () => {
  const { expected, bundle, result } = await setup(3);
  const wrongAnswer = structuredClone(expected);
  wrongAnswer.conflict_values.find((item) => item.field === "date_of_birth")!.values[0] = "1900-01-01";
  const score = scoreCase(result, wrongAnswer, bundle);
  assert.ok("evidenceChecks" in score.checks && "conflictValues" in score.checks);
  assert.equal(score.checks.evidenceChecks, true);
  assert.equal(score.checks.conflictValues, false);
  assert.equal(score.passed, false);
});
