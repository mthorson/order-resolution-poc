import { z } from "zod";
import type { CaseBundle, Citation, Field, ModelProposal } from "./contracts.ts";

export const requiredFields = [
  "patient_id", "patient_name", "date_of_birth", "case_id", "ordering_provider",
  "clinic", "requested_panel", "specimen_type", "collection_date", "provider_signature",
] as const satisfies readonly Field[];

const text = z.string().min(1).refine((value) => value.trim().length > 0);
const field = z.enum(requiredFields);
const citation = z.strictObject({ sourceId: text, quote: text });
const evidence = z.array(citation).min(1);
const fact = z.strictObject({ field, value: text, evidence });
const issue = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("missing"), field, ruleId: z.enum(["R1", "R2"]),
    examinedSourceIds: z.array(text).min(1),
  }),
  z.strictObject({
    kind: z.literal("conflicting"), field, ruleId: z.literal("R4"),
    candidates: z.array(z.strictObject({ value: text, evidence })).min(2),
  }),
]);

export const proposalSchema = z.strictObject({
  schemaVersion: z.literal("model-proposal.v1"),
  facts: z.array(fact).max(requiredFields.length),
  issues: z.array(issue).max(requiredFields.length),
  corrections: z.array(z.strictObject({
    field, originalSourceId: text, replacementSourceId: text, evidence,
  })).max(requiredFields.length),
  sourceAssessments: z.array(z.strictObject({
    sourceId: text, disposition: z.enum(["included", "excluded", "ambiguous"]),
    reason: text, evidence,
  })),
  warnings: z.array(z.strictObject({
    kind: z.enum(["unrelated_document", "instruction_attempt", "ambiguous_identity"]),
    evidence,
  })),
  followUpDraft: z.strictObject({
    subject: text, body: text, addressesFields: z.array(field).min(1),
  }).nullable(),
}) satisfies z.ZodType<ModelProposal>;

export class ProposalValidationError extends Error {
  constructor(
    publicCode: "invalid_output" | "invalid_evidence",
    message: string,
  ) {
    super(message);
    this.name = "ProposalValidationError";
    this.code = publicCode;
  }
  readonly code: "invalid_output" | "invalid_evidence";
}

function requireCheck(condition: boolean, message: string) {
  if (!condition) throw new ProposalValidationError("invalid_evidence", message);
}

function unique(values: string[], description: string) {
  requireCheck(new Set(values).size === values.length, `Duplicate ${description}`);
}

export function validateProposal(value: unknown, bundle: CaseBundle): ModelProposal {
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) {
    // Keep field values and quotations out of ordinary error messages.
    throw new ProposalValidationError("invalid_output", "Model proposal has an invalid shape");
  }
  const proposal = parsed.data;
  unique(bundle.sources.map((source) => source.sourceId), "bundle source ID");
  const sources = new Map(bundle.sources.map((source) => [source.sourceId, source]));
  const dispositions = new Map(proposal.sourceAssessments.map((assessment) =>
    [assessment.sourceId, assessment.disposition]));

  function checkEvidence(citations: Citation[], requireIncluded = false) {
    for (const item of citations) {
      const source = sources.get(item.sourceId);
      requireCheck(source !== undefined && source.content.includes(item.quote),
        "Citation must quote an existing case source exactly");
      if (requireIncluded) {
        requireCheck(dispositions.get(item.sourceId) === "included",
          "Patient facts cannot use excluded or ambiguous sources");
      }
    }
  }

  unique(proposal.sourceAssessments.map((item) => item.sourceId), "source assessment");
  requireCheck(proposal.sourceAssessments.length === sources.size,
    "Every case source needs one assessment");
  for (const assessment of proposal.sourceAssessments) {
    const source = sources.get(assessment.sourceId);
    requireCheck(source !== undefined, "Assessment references an unknown source");
    checkEvidence(assessment.evidence);
    requireCheck(assessment.evidence.some((item) => item.sourceId === assessment.sourceId),
      "Source assessment must cite that source");
    if (assessment.disposition === "included" && source) {
      const caseIds = [...source.content.matchAll(/^Case ID:\s*(.+)$/gm)].map((match) => match[1].trim());
      const patientIds = [...source.content.matchAll(/^Patient ID:\s*(.+)$/gm)].map((match) => match[1].trim());
      requireCheck(caseIds.length > 0 && caseIds.every((id) => id === bundle.caseId) &&
        patientIds.every((id) => id === bundle.patientId),
      "Included source must match the case identity");
    }
  }

  const accountedFields = [...proposal.facts, ...proposal.issues].map((item) => item.field);
  unique(accountedFields, "field finding");
  requireCheck(requiredFields.every((name) => accountedFields.includes(name)),
    "Every required field needs either a proposed fact or an unresolved issue");
  for (const item of proposal.facts) {
    checkEvidence(item.evidence, true);
    if (item.field === "patient_id" || item.field === "case_id") {
      requireCheck(item.value === (item.field === "patient_id" ? bundle.patientId : bundle.caseId),
        "Proposed identity must match the case bundle");
    }
  }
  for (const item of proposal.issues) {
    if (item.kind === "missing") {
      unique(item.examinedSourceIds, "examined source");
      requireCheck(item.examinedSourceIds.every((id) => dispositions.get(id) === "included"),
        "Missing findings must reference included sources");
      const includedIds = proposal.sourceAssessments.filter((a) => a.disposition === "included").map((a) => a.sourceId);
      requireCheck(includedIds.every((id) => item.examinedSourceIds.includes(id)),
        "Missing findings must account for all included sources");
    } else {
      unique(item.candidates.map((candidate) => candidate.value.trim().toLowerCase()), "conflict value");
      for (const candidate of item.candidates) {
        checkEvidence(candidate.evidence, true);
        requireCheck(candidate.evidence.some((entry) =>
          entry.quote.toLowerCase().includes(candidate.value.trim().toLowerCase())),
        "Conflict evidence must contain its proposed value");
      }
    }
  }

  unique(proposal.corrections.map((item) => item.field), "corrected field");
  for (const correction of proposal.corrections) {
    requireCheck(correction.originalSourceId !== correction.replacementSourceId &&
      dispositions.get(correction.originalSourceId) === "included" &&
      dispositions.get(correction.replacementSourceId) === "included",
    "Correction needs distinct included original and replacement sources");
    checkEvidence(correction.evidence, true);
    requireCheck(correction.evidence.some((item) => item.sourceId === correction.replacementSourceId),
      "Correction must cite the replacement source");
    requireCheck(proposal.facts.some((item) => item.field === correction.field &&
      item.evidence.some((entry) => entry.sourceId === correction.replacementSourceId)),
    "Corrected field needs a proposed fact citing its replacement");
  }
  for (const warning of proposal.warnings) checkEvidence(warning.evidence);
  for (const assessment of proposal.sourceAssessments) {
    const kind = assessment.disposition === "excluded" ? "unrelated_document" : "ambiguous_identity";
    if (assessment.disposition !== "included") {
      requireCheck(proposal.warnings.some((warning) => warning.kind === kind &&
        warning.evidence.some((item) => item.sourceId === assessment.sourceId)),
      "Excluded or ambiguous sources need visible warnings");
    }
  }

  if (proposal.issues.length === 0) {
    requireCheck(proposal.followUpDraft === null, "Resolved cases must not request more information");
  } else {
    const draft = proposal.followUpDraft;
    requireCheck(draft !== null, "Unresolved fields need a follow-up draft");
    if (draft) {
      unique(draft.addressesFields, "draft field");
      requireCheck(draft.addressesFields.length === proposal.issues.length &&
        proposal.issues.every((item) => draft.addressesFields.includes(item.field)),
      "Draft must address exactly the unresolved fields");
    }
  }
  return proposal;
}
