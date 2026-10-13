import type { CaseBundle, SourceAssessment, Warning } from "./contracts.ts";

// Fixture-specific identity headers. Unclear documents fail closed.
export function prepareModelCase(bundle: CaseBundle): {
  modelBundle: CaseBundle;
  assessments: SourceAssessment[];
  warnings: Warning[];
} {
  const assessments: SourceAssessment[] = bundle.sources.map((source) => {
    const lines = source.content.split(/\r?\n/);
    const caseLines = lines.filter((line) => line.startsWith("Case ID:"));
    const patientLines = lines.filter((line) => line.startsWith("Patient ID:"));
    const caseIds = caseLines.map((line) => line.slice("Case ID:".length).trim());
    const patientIds = patientLines.map((line) => line.slice("Patient ID:".length).trim());
    const mismatch = caseIds.some((id) => id && id !== bundle.caseId) ||
      patientIds.some((id) => id && id !== bundle.patientId);
    const clear = caseIds.length > 0 && caseIds.every((id) => id === bundle.caseId) &&
      patientIds.every((id) => id === bundle.patientId);
    return {
      sourceId: source.sourceId,
      disposition: mismatch ? "excluded" : clear ? "included" : "ambiguous",
      reason: mismatch ? "Mismatched identity headers" : clear ? "Matching case headers" : "Case identity is unclear",
      evidence: (caseLines.length || patientLines.length ? [...caseLines, ...patientLines] : [lines.find((line) => line.trim())!])
        .map((quote) => ({ sourceId: source.sourceId, quote })),
    };
  });
  const included = new Set(assessments.filter((a) => a.disposition === "included").map((a) => a.sourceId));
  const warnings: Warning[] = assessments.filter((a) => a.disposition !== "included").map((a) => ({
    kind: a.disposition === "excluded" ? "unrelated_document" : "ambiguous_identity",
    evidence: a.evidence,
  }));
  return { modelBundle: { ...bundle, sources: bundle.sources.filter((s) => included.has(s.sourceId)) }, assessments, warnings };
}
