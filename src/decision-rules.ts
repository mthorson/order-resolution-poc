import type { CaseAnalysis, CaseBundle, Field } from "./contracts.ts";
import { ProposalValidationError, validateProposal } from "./validate-proposal.ts";

export const rulesVersion = "demo-order-completeness-v1";
export const fieldLabels: Record<Field, string> = {
  patient_id: "Patient ID", patient_name: "Patient name", date_of_birth: "Date of birth",
  case_id: "Case ID", ordering_provider: "Ordering provider", clinic: "Clinic",
  requested_panel: "Requested panel", specimen_type: "Specimen type",
  collection_date: "Collection date", provider_signature: "Provider signature",
};

export function labeledValues(content: string, label: string): string[] {
  return content.split(/\r?\n/).filter((line) => line.startsWith(`${label}:`))
    .map((line) => line.slice(label.length + 1).trim())
    .filter((value) => value && !/^(\[blank\]|not supplied.*)$/i.test(value));
}

function check(condition: boolean, message: string) {
  if (!condition) throw new ProposalValidationError("invalid_evidence", message);
}

export type Decision = Pick<CaseAnalysis,
  "status" | "facts" | "issues" | "corrections" | "sourceAssessments" |
  "warnings" | "followUpDraft" | "requiresHumanApproval" | "actionState">;

export function applyDecisionRules(value: unknown, bundle: CaseBundle): Decision {
  const proposal = validateProposal(value, bundle);
  const sources = new Map(bundle.sources.map((source) => [source.sourceId, source]));
  const included = proposal.sourceAssessments.filter((item) => item.disposition === "included")
    .map((item) => sources.get(item.sourceId)!);

  for (const correction of proposal.corrections) {
    const original = sources.get(correction.originalSourceId)!;
    const replacement = sources.get(correction.replacementSourceId)!;
    const originalIds = labeledValues(original.content, "Document ID");
    const supersedes = labeledValues(replacement.content, "Supersedes");
    const signatures = labeledValues(replacement.content, "Provider signature");
    const providers = labeledValues(replacement.content, "Ordering provider");
    check(original.kind === "document" && replacement.kind === "document" &&
      originalIds.length === 1 && supersedes.length === 1 && supersedes[0] === originalIds[0] &&
      providers.length === 1 && signatures.length === 1 &&
      signatures[0].startsWith(`${providers[0]}, signed `),
    "Correction must explicitly replace the original in a signed requisition");
    const before = Number(labeledValues(original.content, "Revision")[0]);
    const after = Number(labeledValues(replacement.content, "Revision")[0]);
    check(Number.isSafeInteger(before) && Number.isSafeInteger(after) && after > before,
      "Correction needs a newer explicit revision");
    check(correction.evidence.some((item) => item.sourceId === replacement.sourceId &&
      item.quote.includes(`Supersedes: ${originalIds[0]}`)),
    "Correction evidence must identify the superseded document");
  }

  for (const [field, label] of Object.entries(fieldLabels) as [Field, string][]) {
    const superseded = new Set(proposal.corrections.filter((item) => item.field === field)
      .map((item) => item.originalSourceId));
    const observations = included.filter((source) => !superseded.has(source.sourceId)).flatMap((source) => {
      const values = labeledValues(source.content, label);
      // A narrow check for this demo's explicit email request, not general language understanding.
      if (field === "requested_panel" && source.kind === "correspondence") {
        values.push(...[...source.content.matchAll(/\bPlease run (DEMO-[AB])\b/g)].map((match) => match[1]));
      }
      return values.map((value) => ({ sourceId: source.sourceId, value,
        normalized: (field === "provider_signature" ? value.split(", signed ")[0] : value).toLowerCase() }));
    });
    const distinct = new Set(observations.map((item) => item.normalized));
    const fact = proposal.facts.find((item) => item.field === field);
    const issue = proposal.issues.find((item) => item.field === field);
    if (distinct.size > 1) {
      check(issue?.kind === "conflicting", "Proposal missed an explicit source conflict");
      if (issue?.kind === "conflicting") {
        check([...distinct].every((value) => issue.candidates.some((candidate) => {
          const normalized = (field === "provider_signature" ? candidate.value.split(", signed ")[0] : candidate.value).toLowerCase();
          return normalized === value && candidate.evidence.some((citation) => observations.some((observation) =>
            observation.normalized === value && observation.sourceId === citation.sourceId));
        })), "Conflict must account for each explicit source value");
      }
    } else if (distinct.size === 1) {
      check(issue?.kind !== "missing", "Proposal marked explicitly supplied information missing");
      if (fact) {
        const normalized = (field === "provider_signature" ? fact.value.split(", signed ")[0] : fact.value).toLowerCase();
        check(distinct.has(normalized), "Proposed fact contradicts explicit source information");
      }
    }
    if (fact) {
      check(fact.evidence.some((citation) => citation.quote.toLowerCase().includes(fact.value.toLowerCase())),
        "Fact evidence must contain its proposed value");
    }
  }

  const panelIssue = proposal.issues.find((item) => item.field === "requested_panel");
  const signatureIssue = proposal.issues.find((item) => item.field === "provider_signature");
  if (panelIssue || signatureIssue) {
    const body = proposal.followUpDraft!.body;
    check(/\bsigned\b/i.test(body) && /\brequisition\b/i.test(body),
      "Follow-up must explicitly request a signed requisition");
    if (panelIssue?.kind === "conflicting") {
      check(/\b(corrected|updated|replacement)\b/i.test(body),
        "Conflicting panel follow-up must request a corrected signed requisition");
    }
  }

  const needsClarification = proposal.issues.some((item) => item.kind === "conflicting") ||
    proposal.sourceAssessments.some((item) => item.disposition === "ambiguous") ||
    proposal.warnings.some((item) => item.kind === "ambiguous_identity");
  return {
    facts: proposal.facts,
    issues: proposal.issues,
    corrections: proposal.corrections,
    sourceAssessments: proposal.sourceAssessments,
    warnings: proposal.warnings,
    followUpDraft: proposal.followUpDraft,
    status: needsClarification ? "needs_clarification" : proposal.issues.length ? "needs_information" : "ready_for_review",
    requiresHumanApproval: true,
    actionState: "not_executed",
  };
}
