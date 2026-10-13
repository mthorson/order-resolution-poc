import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCase, defaultAnalysisLimits, ModelInvocationError, type AnalysisOptions, type ModelAdapter } from "../src/analyzer.ts";
import { sha256, snapshotId, validateBundle } from "../src/bundle-integrity.ts";
import { rulesVersion } from "../src/decision-rules.ts";
import { loadCase } from "../src/load-case.ts";
import { prepareModelCase } from "../src/quarantine.ts";
import { demoProposal } from "./helpers/demo-proposal.ts";

const options = (model: ModelAdapter): AnalysisOptions => ({ runId: "test-run", rulesVersion,
  limits: { ...defaultAnalysisLimits }, model });
const fake = (text: string): ModelAdapter => ({ provider: "test", model: "controlled-response",
  async generate() { return { text, completion: "complete", usage: { inputTokens: 10, outputTokens: 20 } }; } });

test("all five cases run through quarantine, controlled proposals, and decision rules", async () => {
  const statuses = ["ready_for_review", "needs_information", "ready_for_review", "needs_clarification", "needs_information"];
  for (let id = 1; id <= 5; id++) {
    const bundle = await loadCase(`fixtures/patients/patient-00${id}`);
    const model: ModelAdapter = { provider: "test", model: "controlled-response",
      async generate(request) {
        const proposal = demoProposal(request.caseBundle);
        const ids = new Set(request.caseBundle.sources.map((s) => s.sourceId));
        proposal.warnings = proposal.warnings.filter((w) => w.evidence.every((e) => ids.has(e.sourceId)));
        if (id === 5) {
          const content = JSON.stringify(request);
          assert.doesNotMatch(content, /CASE-OTHER-900|SYN-OTHER-900|Other Example/);
        }
        return { text: JSON.stringify(proposal), completion: "complete", usage: null };
      } };
    const result = await analyzeCase(bundle, options(model));
    assert.equal(result.outcome, "analyzed");
    if (result.outcome === "analyzed") {
      assert.equal(result.status, statuses[id - 1]);
      assert.equal(result.actionState, "not_executed");
      if (id === 5) assert.ok(result.warnings.some((w) => w.kind === "unrelated_document"));
    }
  }
});

test("unclear source identity stays out of model context and requires review", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  const source = bundle.sources.find((s) => s.kind === "correspondence")!;
  source.content = "Unidentified correspondence\nNo case identifier supplied\n";
  source.sha256 = sha256(source.content);
  bundle.snapshotId = snapshotId(bundle.patientId, bundle.caseId, bundle.sources);
  const prepared = prepareModelCase(bundle);
  assert.ok(!prepared.modelBundle.sources.some((s) => s.sourceId === source.sourceId));
  const result = await analyzeCase(bundle, options(fake(JSON.stringify(demoProposal(prepared.modelBundle)))));
  assert.equal(result.outcome, "analyzed");
  if (result.outcome === "analyzed") assert.equal(result.status, "needs_clarification");
});

test("bad hashes and oversized requests fail before calling the model", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  let calls = 0;
  const model: ModelAdapter = { provider: "test", model: "never-called", async generate() { calls++; throw new Error("unexpected call"); } };
  const invalid = structuredClone(bundle);
  invalid.sources[0].content += "changed";
  const badResult = await analyzeCase(invalid, options(model));
  assert.equal(badResult.outcome, "analysis_failed");
  if (badResult.outcome === "analysis_failed") assert.equal(badResult.error.code, "invalid_input");
  const small = options(model);
  small.limits.maxInputBytes = 1;
  const limitResult = await analyzeCase(bundle, small);
  if (limitResult.outcome === "analysis_failed") assert.equal(limitResult.error.code, "input_limit");
  else assert.fail("Expected input-limit failure");
  assert.equal(calls, 0);
  assert.deepEqual(validateBundle(bundle), bundle);
});

test("invalid JSON, model status claims, and invented citations fail explicitly", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  const proposal = demoProposal(bundle);
  const invented = structuredClone(proposal);
  invented.facts[0].evidence[0].quote = "invented";
  for (const [text, code] of [
    ["not JSON", "invalid_output"], [JSON.stringify({ ...proposal, status: "ready_for_review" }), "invalid_output"],
    [JSON.stringify(invented), "invalid_evidence"],
  ]) {
    const result = await analyzeCase(bundle, options(fake(text)));
    assert.equal(result.outcome, "analysis_failed");
    if (result.outcome === "analysis_failed") assert.equal(result.error.code, code);
  }
});

test("timeouts, provider errors, and truncation produce failures without retrying", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  let calls = 0;
  const timeoutModel: ModelAdapter = { provider: "test", model: "timeout", async generate(request) {
    calls++;
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new ModelInvocationError()), { once: true }));
  } };
  const settings = options(timeoutModel);
  settings.limits.timeoutMs = 10;
  const result = await analyzeCase(bundle, settings);
  if (result.outcome === "analysis_failed") assert.equal(result.error.code, "budget_exhausted");
  else assert.fail("Expected timeout failure");
  assert.equal(calls, 1);
  const provider = await analyzeCase(bundle, options({ ...timeoutModel, async generate() { throw new ModelInvocationError(); } }));
  if (provider.outcome === "analysis_failed") assert.equal(provider.error.code, "provider_error");
  else assert.fail("Expected provider failure");
  const truncated = await analyzeCase(bundle, options({ ...timeoutModel, async generate() {
    return { text: "{}", completion: "truncated", usage: null };
  } }));
  if (truncated.outcome === "analysis_failed") assert.equal(truncated.error.code, "invalid_output");
  else assert.fail("Expected truncation failure");
});

test("running A then B uses independent case contexts", async () => {
  const seen: string[] = [];
  const model: ModelAdapter = { provider: "test", model: "context-check", async generate(request) {
    seen.push(JSON.stringify(request.caseBundle));
    return { text: JSON.stringify(demoProposal(request.caseBundle)), completion: "complete", usage: null };
  } };
  for (const id of ["001", "002"]) {
    const result = await analyzeCase(await loadCase(`fixtures/patients/patient-${id}`), options(model));
    assert.equal(result.outcome, "analyzed");
  }
  assert.doesNotMatch(seen[1], /SYN-001|Alex Example|CASE-001/);
  assert.doesNotMatch(seen[0], /SYN-002|Blair Example|CASE-002/);
});

test("missing-field source inventory includes supplied inputs but rejects invented IDs", async () => {
  const bundle = await loadCase("fixtures/patients/patient-002");
  const prepared = prepareModelCase(bundle);
  const proposal = demoProposal(prepared.modelBundle);
  for (const issue of proposal.issues) if (issue.kind === "missing") issue.examinedSourceIds = [prepared.modelBundle.sources[0].sourceId];
  const result = await analyzeCase(bundle, options(fake(JSON.stringify(proposal))));
  assert.equal(result.outcome, "analyzed");
  if (result.outcome === "analyzed") for (const issue of result.issues) if (issue.kind === "missing") {
    assert.deepEqual(issue.examinedSourceIds, prepared.modelBundle.sources.map((source) => source.sourceId));
  }
  const missing = proposal.issues.find((issue) => issue.kind === "missing");
  assert.ok(missing && missing.kind === "missing");
  missing.examinedSourceIds.push("invented-source");
  const invalid = await analyzeCase(bundle, options(fake(JSON.stringify(proposal))));
  assert.equal(invalid.outcome, "analysis_failed");
});
