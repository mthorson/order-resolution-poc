import type { AnalysisResult, CaseBundle } from "./contracts.ts";

export type ReviewRecord = {
  reviewId: string;
  createdAt: string;
  runId: string;
  snapshotId: string;
  resultSha256: string;
  reviewer: string;
  reviewerIdentity?: { issuer: string; subject: string };
  decision: "accepted" | "changes_requested" | "rejected";
  notes: string;
  draftBody: string | null;
  evidenceChecked: true;
  reviewDurationMs?: number;
  previousReviewId: string | null;
};

export type ReviewSummary = {
  runId: string;
  caseId: string;
  patientFolder: string;
  patientName: string;
  status: "ready_for_review" | "needs_information" | "needs_clarification" | "analysis_failed";
  issueCount: number;
  reviewDecision: ReviewRecord["decision"] | null;
  stale: boolean;
};

export type ReviewDetail = {
  result: AnalysisResult;
  bundle: CaseBundle;
  resultSha256: string;
  review: ReviewRecord | null;
  sourceState: "current" | "changed" | "unavailable";
};

export type ReviewInput = {
  snapshotId: string;
  resultSha256: string;
  expectedReviewId: string | null;
  reviewer: string;
  decision: ReviewRecord["decision"];
  notes: string;
  draftBody: string | null;
  evidenceChecked: true;
  reviewDurationMs?: number;
};
