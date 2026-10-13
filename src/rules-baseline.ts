import { performance } from "node:perf_hooks";
import type { CaseAnalysis, CaseBundle, Field, Warning } from "./contracts.ts";
import { fieldLabels, labeledValues } from "./decision-rules.ts";
import { prepareModelCase } from "./quarantine.ts";

export type BaselineResult = {
  status: CaseAnalysis["status"];
  missingFields: Field[];
  conflictingFields: Field[];
  resolvedFields: Field[];
  warningKinds: Warning["kind"][];
  durationMs: number;
};

const normalized = (field: Field, value: string) =>
  (field === "provider_signature" ? value.split(", signed ")[0] : value).toLowerCase();

// Narrow baseline for these text fixtures; no model or expected-answer access.
export function rulesBaseline(bundle: CaseBundle): BaselineResult {
  const started = performance.now();
  const { modelBundle, warnings, assessments } = prepareModelCase(bundle);
  const superseded = new Set<string>();
  const resolvedFields = new Set<Field>();
  for (const replacement of modelBundle.sources.filter((s) => s.kind === "document")) {
    const replacedIds = labeledValues(replacement.content, "Supersedes");
    const originals = modelBundle.sources.filter((s) =>
      labeledValues(s.content, "Document ID").some((id) => replacedIds.includes(id)));
    if (replacedIds.length !== 1 || originals.length !== 1) continue;
    const original = originals[0];
    const provider = labeledValues(replacement.content, "Ordering provider");
    const signature = labeledValues(replacement.content, "Provider signature");
    const before = Number(labeledValues(original.content, "Revision")[0]);
    const after = Number(labeledValues(replacement.content, "Revision")[0]);
    if (provider.length !== 1 || signature.length !== 1 ||
      !signature[0].startsWith(`${provider[0]}, signed `) ||
      !Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after <= before) continue;
    superseded.add(original.sourceId);
    for (const [field, label] of Object.entries(fieldLabels) as [Field, string][]) {
      const oldValues = labeledValues(original.content, label).map((v) => normalized(field, v));
      const newValues = labeledValues(replacement.content, label).map((v) => normalized(field, v));
      if (newValues.length === 1 && (oldValues.length === 0 || oldValues.some((v) => v !== newValues[0]))) resolvedFields.add(field);
    }
  }
  const active = modelBundle.sources.filter((s) => !superseded.has(s.sourceId));
  const missingFields: Field[] = [];
  const conflictingFields: Field[] = [];
  for (const [field, label] of Object.entries(fieldLabels) as [Field, string][]) {
    const values = active.flatMap((source) => {
      const found = labeledValues(source.content, label);
      if (field === "requested_panel" && source.kind === "correspondence") {
        found.push(...[...source.content.matchAll(/\bPlease run (DEMO-[AB])\b/g)].map((m) => m[1]));
      }
      return found.map((v) => normalized(field, v));
    });
    const distinct = new Set(values);
    if (distinct.size === 0) missingFields.push(field);
    if (distinct.size > 1) conflictingFields.push(field);
  }
  const warningKinds = new Set(warnings.map((w) => w.kind));
  if (active.some((s) => s.content.includes("SYSTEM OVERRIDE:"))) warningKinds.add("instruction_attempt");
  return {
    status: conflictingFields.length || assessments.some((a) => a.disposition === "ambiguous")
      ? "needs_clarification" : missingFields.length ? "needs_information" : "ready_for_review",
    missingFields, conflictingFields, resolvedFields: [...resolvedFields], warningKinds: [...warningKinds],
    durationMs: performance.now() - started,
  };
}
