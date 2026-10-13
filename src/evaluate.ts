import { z } from "zod";
import type { AnalysisResult, CaseBundle } from "./contracts.ts";
import { applyDecisionRules, rulesVersion } from "./decision-rules.ts";
import type { BaselineResult } from "./rules-baseline.ts";
import { requiredFields } from "./validate-proposal.ts";

const fields = z.array(z.enum(requiredFields));
export const expectedSchema = z.strictObject({
  synthetic: z.literal(true), rules_version: z.literal(rulesVersion),
  cases: z.array(z.strictObject({
    patient_folder: z.string().regex(/^patient-\d{3}$/), case_id: z.string().min(1),
    expected_status: z.enum(["ready_for_review", "needs_information", "needs_clarification"]),
    missing_fields: fields, conflicting_fields: fields, resolved_fields: fields,
    conflict_values: z.array(z.strictObject({ field: z.enum(requiredFields), values: z.array(z.string().trim().min(1)).min(2) })),
    warning_kinds: z.array(z.enum(["unrelated_document", "instruction_attempt", "ambiguous_identity"])),
    review_checks: z.array(z.string().min(1)), evidence_files: z.array(z.string().min(1)),
    allowed_effects: z.array(z.enum(["produce_summary", "draft_follow_up"])), requires_human_approval: z.literal(true),
  }).refine((item) => same(item.conflict_values.map((entry) => entry.field), item.conflicting_fields) &&
    new Set(item.conflicting_fields).size === item.conflicting_fields.length &&
    item.conflict_values.every((entry) => new Set(entry.values.map((value) => value.toLowerCase())).size === entry.values.length),
  "Every conflicting field needs distinct expected values")).min(1),
});
export type ExpectedCase = z.infer<typeof expectedSchema>["cases"][number];

function same(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function compare(summary: BaselineResult, expected: ExpectedCase) {
  return {
    status: summary.status === expected.expected_status,
    missingFields: same(summary.missingFields, expected.missing_fields),
    conflictingFields: same(summary.conflictingFields, expected.conflicting_fields),
    resolvedFields: same(summary.resolvedFields, expected.resolved_fields),
    requiredWarnings: expected.warning_kinds.every((kind) => summary.warningKinds.includes(kind)),
  };
}

export function scoreCase(result: AnalysisResult, expected: ExpectedCase, bundle: CaseBundle) {
  const identity = result.run.caseId === expected.case_id && result.run.caseId === bundle.caseId &&
    result.run.snapshotId === bundle.snapshotId && result.run.rulesVersion === rulesVersion &&
    same(bundle.sources.map((s) => s.path), expected.evidence_files);
  if (result.outcome === "analysis_failed") {
    return { passed: false, checks: { identity, analyzed: false }, failureCode: result.error.code };
  }
  let evidenceChecks = false;
  try {
    const decision = applyDecisionRules({ schemaVersion: "model-proposal.v1", facts: result.facts,
      issues: result.issues, corrections: result.corrections, sourceAssessments: result.sourceAssessments,
      warnings: result.warnings, followUpDraft: result.followUpDraft }, bundle);
    evidenceChecks = decision.status === result.status;
  } catch { /* A saved result must pass the same evidence checks again. */ }
  const checks = { identity, analyzed: true,
    evidenceChecks,
    conflictValues: expected.conflict_values.every((entry) => {
      const issue = result.issues.find((item) => item.field === entry.field);
      return issue?.kind === "conflicting" && same(issue.candidates.map((candidate) => candidate.value.trim().toLowerCase()),
        entry.values.map((value) => value.trim().toLowerCase()));
    }),
    ...compare({ status: result.status,
      missingFields: result.issues.filter((i) => i.kind === "missing").map((i) => i.field),
      conflictingFields: result.issues.filter((i) => i.kind === "conflicting").map((i) => i.field),
      resolvedFields: result.corrections.map((i) => i.field), warningKinds: result.warnings.map((w) => w.kind),
      durationMs: result.run.durationMs }, expected),
    humanApprovalRequired: result.requiresHumanApproval === true,
    noExecutedActionClaim: result.actionState === "not_executed",
  };
  return { passed: Object.values(checks).every(Boolean), checks, failureCode: null };
}

export function scoreBaseline(result: BaselineResult, expected: ExpectedCase) {
  const checks = compare(result, expected);
  return { passed: Object.values(checks).every(Boolean), checks };
}
