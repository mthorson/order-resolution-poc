import type { CaseAnalysis, Citation } from "../src/contracts.ts";

export type EvidenceGroup = { id: string; title: string; citations: Citation[]; examinedSourceIds: string[] };
const title = (field: string) => field.replaceAll("_", " ").replace(/\bid\b/g, "ID").replace(/^./, (c) => c.toUpperCase());

export function evidenceGroups(result: CaseAnalysis, tab: string): EvidenceGroup[] {
  if (tab === "facts") return result.facts.map((fact) => ({ id: `facts:${fact.field}`, title: title(fact.field), citations: fact.evidence, examinedSourceIds: [] }));
  if (tab === "corrections") return result.corrections.map((correction) => ({
    id: `corrections:${correction.field}`, title: `${title(correction.field)} · signed correction`, citations: correction.evidence, examinedSourceIds: [],
  }));
  return result.issues.map((issue) => ({ id: `issues:${issue.field}`, title: title(issue.field),
    citations: issue.kind === "conflicting" ? issue.candidates.flatMap((candidate) => candidate.evidence) : [],
    examinedSourceIds: issue.kind === "missing" ? issue.examinedSourceIds : [],
  }));
}

// Keep the exact quote and nearby original text; never synthesize a passage.
export function evidenceExcerpt(content: string, quote: string, context = 100) {
  const offset = quote ? content.indexOf(quote) : -1;
  if (offset < 0) return null;
  const start = Math.max(0, offset - context);
  const end = Math.min(content.length, offset + quote.length + context);
  return { before: content.slice(start, offset), quote,
    after: content.slice(offset + quote.length, end), clippedStart: start > 0, clippedEnd: end < content.length };
}
