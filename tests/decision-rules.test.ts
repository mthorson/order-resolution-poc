import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applyDecisionRules } from "../src/decision-rules.ts";
import { loadCase } from "../src/load-case.ts";
import { demoProposal } from "./helpers/demo-proposal.ts";

test("prepared proposals for all five cases produce the expected decisions", async () => {
  const expected = JSON.parse(await readFile("evals/expected-outcomes.json", "utf8"));
  for (const item of expected.cases) {
    const bundle = await loadCase(`fixtures/patients/${item.patient_folder}`);
    const decision = applyDecisionRules(demoProposal(bundle), bundle);
    assert.equal(decision.status, item.expected_status);
    assert.deepEqual(decision.issues.filter((issue) => issue.kind === "missing").map((issue) => issue.field).sort(), [...item.missing_fields].sort());
    assert.deepEqual(decision.issues.filter((issue) => issue.kind === "conflicting").map((issue) => issue.field).sort(), [...item.conflicting_fields].sort());
    assert.deepEqual(decision.corrections.map((correction) => correction.field).sort(), [...item.resolved_fields].sort());
    assert.equal(decision.actionState, "not_executed");
    assert.equal(decision.requiresHumanApproval, true);
    assert.ok(!("schemaVersion" in decision));
  }
});

test("rejects a ready-looking proposal that misses the email panel conflict", async () => {
  const bundle = await loadCase("fixtures/patients/patient-004");
  const proposal = demoProposal(bundle);
  proposal.issues = proposal.issues.filter((item) => item.field !== "requested_panel");
  proposal.facts.push({ field: "requested_panel", value: "DEMO-A",
    evidence: [{ sourceId: "documents/01-requisition.txt", quote: "Requested panel: DEMO-A" }] });
  proposal.followUpDraft!.addressesFields = ["date_of_birth"];
  assert.throws(() => applyDecisionRules(proposal, bundle), /missed an explicit source conflict/);
});

test("rejects missing claims for supplied fields and values unsupported by quotes", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  const missing = demoProposal(bundle);
  missing.facts = missing.facts.filter((item) => item.field !== "collection_date");
  missing.issues.push({ kind: "missing", field: "collection_date", ruleId: "R2",
    examinedSourceIds: bundle.sources.map((source) => source.sourceId) });
  missing.followUpDraft = { subject: "Date", body: "Please provide collection date", addressesFields: ["collection_date"] };
  assert.throws(() => applyDecisionRules(missing, bundle), /explicitly supplied/);
  const invented = demoProposal(bundle);
  invented.facts.find((item) => item.field === "requested_panel")!.value = "DEMO-B";
  assert.throws(() => applyDecisionRules(invented, bundle), /contradicts/);
});

test("rejects unsigned corrections, wrong supersession, and older revisions", async () => {
  for (const [from, to, expected] of [
    ["Provider signature: Dr. Riley Demo, signed 2026-10-05", "Provider signature: [blank]", /signed requisition/],
    ["Supersedes: P003-D01", "Supersedes: OTHER", /signed requisition/],
    ["Revision: 2", "Revision: 0", /newer explicit revision/],
  ]) {
    const bundle = await loadCase("fixtures/patients/patient-003");
    const replacement = bundle.sources.find((source) => source.path.includes("corrected"))!;
    replacement.content = replacement.content.replace(from as string, to as string);
    const proposal = demoProposal(bundle);
    proposal.corrections[0].evidence[0].quote = replacement.content.split("\n").find((line) => line.startsWith("Supersedes:"))!;
    assert.throws(() => applyDecisionRules(proposal, bundle), expected as RegExp);
  }
});

test("source ambiguity requires clarification even when required fields are supplied", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  const proposal = demoProposal(bundle);
  const message = proposal.sourceAssessments.find((item) => item.sourceId.startsWith("correspondence/"))!;
  message.disposition = "ambiguous";
  proposal.warnings.push({ kind: "ambiguous_identity", evidence: message.evidence });
  assert.equal(applyDecisionRules(proposal, bundle).status, "needs_clarification");
});

test("panel conflicts need a corrected signed requisition, not email confirmation alone", async () => {
  const bundle = await loadCase("fixtures/patients/patient-004");
  const proposal = demoProposal(bundle);
  proposal.followUpDraft!.body = "Please reconcile the dates of birth and confirm which panel should be run.";
  assert.throws(() => applyDecisionRules(proposal, bundle), /signed requisition/);
  proposal.followUpDraft!.body = "Please reconcile the dates of birth and provide a signed requisition confirming the panel.";
  assert.throws(() => applyDecisionRules(proposal, bundle), /corrected signed requisition/);
  proposal.followUpDraft!.body = "Please reconcile the dates of birth and provide a corrected signed requisition confirming the panel.";
  assert.equal(applyDecisionRules(proposal, bundle).status, "needs_clarification");
});

test("a missing signature cannot be satisfied by a promise in the follow-up draft", async () => {
  const bundle = await loadCase("fixtures/patients/patient-002");
  const proposal = demoProposal(bundle);
  proposal.followUpDraft!.body = "Please confirm you will sign later and provide the collection date.";
  assert.throws(() => applyDecisionRules(proposal, bundle), /signed requisition/);
});
