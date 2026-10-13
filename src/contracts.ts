// Compile-time contracts. Model proposal runtime checks live in validate-proposal.ts.
export type Field =
  | "patient_id"
  | "patient_name"
  | "date_of_birth"
  | "case_id"
  | "ordering_provider"
  | "clinic"
  | "requested_panel"
  | "specimen_type"
  | "collection_date"
  | "provider_signature";

export type CaseSource = {
  sourceId: string;
  path: string; // Relative to this case folder.
  kind: "document" | "correspondence";
  content: string;
  sha256: string; // Hash of the original file bytes.
};

export type CaseBundle = {
  schemaVersion: "case-bundle.v1";
  patientId: string;
  caseId: string;
  snapshotId: string; // Hash of manifest identity and sorted file paths/hashes.
  sources: CaseSource[];
};

export type Citation = {
  sourceId: string;
  quote: string; // Exact, nonempty substring of the referenced source.
};

export type ProposedFact = {
  field: Field;
  value: string;
  evidence: Citation[];
};

export type Issue =
  | {
      kind: "missing";
      field: Field;
      ruleId: string;
      examinedSourceIds: string[];
    }
  | {
      kind: "conflicting";
      field: Field;
      ruleId: string;
      candidates: { value: string; evidence: Citation[] }[];
    };

export type Correction = {
  field: Field;
  originalSourceId: string;
  replacementSourceId: string;
  evidence: Citation[];
};

export type SourceAssessment = {
  sourceId: string;
  disposition: "included" | "excluded" | "ambiguous";
  reason: string;
  evidence: Citation[];
};

export type Warning = {
  kind: "unrelated_document" | "instruction_attempt" | "ambiguous_identity";
  evidence: Citation[];
};

export type FollowUpDraft = {
  subject: string;
  body: string;
  addressesFields: Field[];
};

// Untrusted output: the model cannot declare final status or authorize actions.
export type ModelProposal = {
  schemaVersion: "model-proposal.v1";
  facts: ProposedFact[];
  issues: Issue[];
  corrections: Correction[];
  sourceAssessments: SourceAssessment[];
  warnings: Warning[];
  followUpDraft: FollowUpDraft | null;
};

export type RunMetadata = {
  runId: string;
  caseId: string;
  snapshotId: string;
  rulesVersion: string;
  promptVersion: string;
  validatorVersion: string;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  modelCalls: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  estimatedCostUsd: number | null;
  costBasis: string | null;
};

export type CaseAnalysis = {
  schemaVersion: "case-analysis.v1";
  outcome: "analyzed";
  run: RunMetadata;
  status: "ready_for_review" | "needs_information" | "needs_clarification";
  facts: ProposedFact[]; // Validated, current, uncontested facts only.
  issues: Issue[];
  corrections: Correction[];
  sourceAssessments: SourceAssessment[];
  warnings: Warning[];
  followUpDraft: FollowUpDraft | null;
  requiresHumanApproval: true;
  actionState: "not_executed";
};

export type AnalysisFailure = {
  schemaVersion: "case-analysis.v1";
  outcome: "analysis_failed";
  run: RunMetadata;
  error: {
    code:
      | "invalid_input"
      | "input_limit"
      | "provider_error"
      | "budget_exhausted"
      | "invalid_output"
      | "invalid_evidence";
    message: string;
    sourceIds: string[];
  };
  requiresHumanApproval: true;
  actionState: "not_executed";
};

export type AnalysisResult = CaseAnalysis | AnalysisFailure;
