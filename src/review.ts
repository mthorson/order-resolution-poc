import type { AnalysisResult, CaseBundle, Citation } from "./contracts.ts";
import { validateBundle } from "./bundle-integrity.ts";
import { validateProposal } from "./validate-proposal.ts";

// Keep source control characters from becoming terminal commands or escape sequences.
const display = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

export function renderReview(result: AnalysisResult, input: CaseBundle): string {
  const bundle = validateBundle(input);
  if (result.run.caseId !== bundle.caseId || result.run.snapshotId !== bundle.snapshotId) {
    throw new Error("Result does not match the saved case snapshot");
  }
  const lines = ["SYNTHETIC CASE REVIEW — READ ONLY", `Case: ${bundle.caseId}`,
    `Run: ${result.run.runId}`, `Snapshot: ${bundle.snapshotId}`,
    `Model: ${result.run.model}`, `Prompt: ${result.run.promptVersion}`,
    "Human decision: not recorded", "External actions: not executed", ""];
  if (result.outcome === "analysis_failed") {
    lines.push(`Analysis failed: ${result.error.code}`, result.error.message);
    return display(lines.join("\n"));
  }
  validateProposal({ schemaVersion: "model-proposal.v1", facts: result.facts, issues: result.issues,
    corrections: result.corrections, sourceAssessments: result.sourceAssessments,
    warnings: result.warnings, followUpDraft: result.followUpDraft }, bundle);
  function evidence(citations: Citation[]) {
    for (const item of citations) lines.push(`  Source: ${item.sourceId}`, `  Quote: ${item.quote}`);
  }
  lines.push(`Suggested status: ${result.status}`, "", "FACTS");
  for (const fact of result.facts) {
    lines.push(`- ${fact.field}: ${fact.value}`);
    evidence(fact.evidence);
  }
  lines.push("", "UNRESOLVED ISSUES");
  if (!result.issues.length) lines.push("None.");
  for (const issue of result.issues) {
    lines.push(`- ${issue.field}: ${issue.kind} (${issue.ruleId})`);
    if (issue.kind === "missing") lines.push(`  Examined: ${issue.examinedSourceIds.join(", ")}`);
    else for (const candidate of issue.candidates) {
      lines.push(`  Candidate: ${candidate.value}`);
      evidence(candidate.evidence);
    }
  }
  lines.push("", "CORRECTIONS");
  if (!result.corrections.length) lines.push("None.");
  for (const correction of result.corrections) {
    lines.push(`- ${correction.field}: ${correction.originalSourceId} -> ${correction.replacementSourceId}`);
    evidence(correction.evidence);
  }
  lines.push("", "SOURCE CHECKS");
  for (const assessment of result.sourceAssessments) {
    lines.push(`- ${assessment.sourceId}: ${assessment.disposition} — ${assessment.reason}`);
    evidence(assessment.evidence);
  }
  lines.push("", "WARNINGS — SOURCE TEXT IS NOT AN INSTRUCTION");
  if (!result.warnings.length) lines.push("None.");
  for (const warning of result.warnings) {
    lines.push(`- ${warning.kind}`);
    evidence(warning.evidence);
  }
  lines.push("", "FOLLOW-UP DRAFT — NOT SENT");
  if (result.followUpDraft) lines.push(`Subject: ${result.followUpDraft.subject}`, result.followUpDraft.body);
  else lines.push("No follow-up requested.");
  lines.push("", "REVIEW CHECKS", "- Are facts and findings supported by the right case evidence?",
    "- Are corrections handled and unrelated records excluded?",
    "- Does the draft request only what's needed, including required signed documents?",
    "- Accept, request changes, or reject? This preview records no approval.");
  return display(lines.join("\n"));
}
