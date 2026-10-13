import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCase, defaultAnalysisLimits } from "../src/analyzer.ts";
import { rulesVersion } from "../src/decision-rules.ts";
import { loadCase } from "../src/load-case.ts";
import { prepareModelCase } from "../src/quarantine.ts";
import { renderReview } from "../src/review.ts";
import { demoProposal } from "./helpers/demo-proposal.ts";

async function reviewCase(id: string) {
  const bundle = await loadCase(`fixtures/patients/patient-${id}`);
  const prepared = prepareModelCase(bundle).modelBundle;
  const proposal = demoProposal(prepared);
  const ids = new Set(prepared.sources.map((s) => s.sourceId));
  proposal.warnings = proposal.warnings.filter((w) => w.evidence.every((e) => ids.has(e.sourceId)));
  const result = await analyzeCase(bundle, { runId: "test-review", rulesVersion,
    limits: { ...defaultAnalysisLimits }, model: { provider: "test", model: "prepared",
      async generate() { return { text: JSON.stringify(proposal), completion: "complete", usage: null }; } } });
  return { bundle, result };
}

test("review presents conflicts, source quotes, and the unsent follow-up draft without approving", async () => {
  const { bundle, result } = await reviewCase("004");
  const before = structuredClone(result);
  const text = renderReview(result, bundle);
  assert.match(text, /Date of birth: 1982-04-09/);
  assert.match(text, /Date of birth: 1982-04-19/);
  assert.match(text, /corrected signed requisition/);
  assert.match(text, /Human decision: not recorded/);
  assert.match(text, /FOLLOW-UP DRAFT — NOT SENT/);
  assert.deepEqual(result, before);
});

test("review refuses mismatched cases, changed input, and invented evidence", async () => {
  const { bundle, result } = await reviewCase("001");
  const other = await loadCase("fixtures/patients/patient-002");
  assert.throws(() => renderReview(result, other), /snapshot/);
  const changed = structuredClone(bundle);
  changed.sources[0].content += "changed";
  assert.throws(() => renderReview(result, changed), /integrity/);
  if (result.outcome !== "analyzed") assert.fail("Expected analyzed result");
  const fabricated = structuredClone(result);
  fabricated.facts[0].evidence[0].quote = "invented quote";
  assert.throws(() => renderReview(fabricated, bundle), /Citation/);
});

test("review shows quarantined and injected content as warnings, not instructions", async () => {
  const { bundle, result } = await reviewCase("005");
  const text = renderReview(result, bundle);
  assert.match(text, /documents\/02-unrelated-requisition.txt: excluded/);
  assert.match(text, /SOURCE TEXT IS NOT AN INSTRUCTION/);
  assert.match(text, /instruction_attempt/);
});
