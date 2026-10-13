import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseBundle, Field, ModelProposal } from "../src/contracts.ts";
import { loadCase } from "../src/load-case.ts";
import { ProposalValidationError, validateProposal } from "../src/validate-proposal.ts";

const labels: Record<Field, string> = {
  patient_id: "Patient ID", patient_name: "Patient name", date_of_birth: "Date of birth",
  case_id: "Case ID", ordering_provider: "Ordering provider", clinic: "Clinic",
  requested_panel: "Requested panel", specimen_type: "Specimen type",
  collection_date: "Collection date", provider_signature: "Provider signature",
};

function completeProposal(bundle: CaseBundle, requisitionPath = "documents/01-requisition.txt"): ModelProposal {
  const source = bundle.sources.find((item) => item.path === requisitionPath)!;
  return {
    schemaVersion: "model-proposal.v1",
    facts: Object.entries(labels).map(([field, label]) => {
      const quote = source.content.split("\n").find((line) => line.startsWith(`${label}:`))!;
      return { field: field as Field, value: quote.slice(label.length + 1).trim(),
        evidence: [{ sourceId: source.sourceId, quote }] };
    }),
    issues: [], corrections: [], warnings: [], followUpDraft: null,
    sourceAssessments: bundle.sources.map((item) => ({
      sourceId: item.sourceId, disposition: "included", reason: "Matching case identifier",
      evidence: [{ sourceId: item.sourceId, quote: `Case ID: ${bundle.caseId}` }],
    })),
  };
}

function rejects(value: unknown, bundle: CaseBundle, code: string) {
  assert.throws(() => validateProposal(value, bundle), (error: unknown) =>
    error instanceof ProposalValidationError && error.code === code);
}

test("accepts a well-shaped complete proposal with exact case evidence", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  const proposal = completeProposal(bundle);
  assert.deepEqual(validateProposal(proposal, bundle), proposal);
});

test("rejects invalid shapes, unsupported versions, blank quotes, and model status claims", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  const base = completeProposal(bundle);
  for (const value of [null, {}, { ...base, schemaVersion: "model-proposal.v2" },
    { ...base, status: "ready_for_review" }]) rejects(value, bundle, "invalid_output");
  const bad = structuredClone(base);
  bad.facts[0].evidence[0].quote = " ";
  rejects(bad, bundle, "invalid_output");
});

test("rejects invented quotes, unknown sources, and unassessed sources", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  for (const change of [
    (p: ModelProposal) => { p.facts[0].evidence[0].quote = "Invented evidence"; },
    (p: ModelProposal) => { p.facts[0].evidence[0].sourceId = "unknown.txt"; },
    (p: ModelProposal) => { p.sourceAssessments.pop(); },
    (p: ModelProposal) => { p.sourceAssessments.push(p.sourceAssessments[0]); },
  ]) {
    const proposal = completeProposal(bundle);
    change(proposal);
    rejects(proposal, bundle, "invalid_evidence");
  }
});

test("rejects omitted, duplicated, or simultaneously resolved and missing fields", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  for (const change of [
    (p: ModelProposal) => { p.facts.pop(); },
    (p: ModelProposal) => { p.facts[1] = p.facts[0]; },
    (p: ModelProposal) => { p.issues.push({ kind: "missing", field: "patient_id",
      ruleId: "R1", examinedSourceIds: bundle.sources.map((s) => s.sourceId) }); },
  ]) {
    const proposal = completeProposal(bundle);
    change(proposal);
    rejects(proposal, bundle, "invalid_evidence");
  }
});

test("missing findings account for included sources and drafts target unresolved fields", async () => {
  const bundle = await loadCase("fixtures/patients/patient-002");
  const proposal = completeProposal(bundle);
  proposal.facts = proposal.facts.filter((item) => !["collection_date", "provider_signature"].includes(item.field));
  proposal.issues = ["collection_date", "provider_signature"].map((field) => ({
    kind: "missing", field: field as Field, ruleId: "R2",
    examinedSourceIds: bundle.sources.map((s) => s.sourceId),
  }));
  proposal.followUpDraft = { subject: "Missing information", body: "Please provide the collection date and signed requisition.",
    addressesFields: ["collection_date", "provider_signature"] };
  assert.deepEqual(validateProposal(proposal, bundle), proposal);
  const incompleteSearch = structuredClone(proposal);
  const issue = incompleteSearch.issues[0];
  if (issue.kind === "missing") issue.examinedSourceIds.pop();
  rejects(incompleteSearch, bundle, "invalid_evidence");
  const wrongDraft = structuredClone(proposal);
  wrongDraft.followUpDraft!.addressesFields = ["requested_panel"];
  rejects(wrongDraft, bundle, "invalid_evidence");
});

test("corrections reference distinct sources and the replacement fact", async () => {
  const bundle = await loadCase("fixtures/patients/patient-003");
  const replacement = "documents/02-requisition-corrected.txt";
  const proposal = completeProposal(bundle, replacement);
  proposal.corrections = [{ field: "requested_panel", originalSourceId: "documents/01-requisition-original.txt",
    replacementSourceId: replacement, evidence: [{ sourceId: replacement, quote: "Supersedes: P003-D01" }] }];
  assert.deepEqual(validateProposal(proposal, bundle), proposal);
  proposal.corrections[0].originalSourceId = replacement;
  rejects(proposal, bundle, "invalid_evidence");
});

test("rejects wrong-case sources marked included and wrong proposed identities", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  const wrongIdentity = completeProposal(bundle);
  wrongIdentity.facts.find((item) => item.field === "patient_id")!.value = "SYN-OTHER";
  rejects(wrongIdentity, bundle, "invalid_evidence");
  const contaminated = structuredClone(bundle);
  contaminated.sources[0].content += "\nPatient ID: SYN-OTHER\n";
  rejects(completeProposal(contaminated), contaminated, "invalid_evidence");
});

test("excluded sources need warnings and cannot support patient facts", async () => {
  const bundle = await loadCase("fixtures/patients/patient-001");
  bundle.sources.push({ sourceId: "documents/unrelated.txt", path: "documents/unrelated.txt", kind: "document",
    content: "Case ID: OTHER\nPatient ID: OTHER\n", sha256: "test-only" });
  const proposal = completeProposal(bundle);
  const excluded = proposal.sourceAssessments.at(-1)!;
  excluded.disposition = "excluded";
  excluded.reason = "Wrong case";
  excluded.evidence = [{ sourceId: excluded.sourceId, quote: "Case ID: OTHER" }];
  rejects(proposal, bundle, "invalid_evidence");
  proposal.warnings.push({ kind: "unrelated_document", evidence: excluded.evidence });
  assert.deepEqual(validateProposal(proposal, bundle), proposal);
  proposal.facts[0].evidence = excluded.evidence;
  rejects(proposal, bundle, "invalid_evidence");
});

test("conflicts need distinct candidate values; unresolved fields cannot be facts", async () => {
  const bundle = await loadCase("fixtures/patients/patient-004");
  const proposal = completeProposal(bundle);
  proposal.facts = proposal.facts.filter((item) => item.field !== "date_of_birth");
  proposal.issues = [{ kind: "conflicting", field: "date_of_birth", ruleId: "R4", candidates: [
    { value: "1982-04-09", evidence: [{ sourceId: "documents/01-requisition.txt", quote: "Date of birth: 1982-04-09" }] },
    { value: "1982-04-19", evidence: [{ sourceId: "documents/02-specimen-record.txt", quote: "Date of birth: 1982-04-19" }] },
  ] }];
  proposal.followUpDraft = { subject: "Identity clarification", body: "Please reconcile the conflicting dates of birth.",
    addressesFields: ["date_of_birth"] };
  // This checks proposal mechanics only; the panel conflict is not detected here.
  validateProposal(proposal, bundle);
  if (proposal.issues[0].kind === "conflicting") {
    proposal.issues[0].candidates[1].value = "1982-04-09";
  }
  rejects(proposal, bundle, "invalid_evidence");
});
