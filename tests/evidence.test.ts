import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceExcerpt, evidenceGroups } from "../web/evidence.ts";
import { loadCase } from "../src/load-case.ts";
import { analyzeCase, defaultAnalysisLimits } from "../src/analyzer.ts";
import { rulesVersion } from "../src/decision-rules.ts";
import { demoProposal } from "./helpers/demo-proposal.ts";

test("excerpts preserve exact quotes and original context, including multiline quotes", () => {
  const content = "Earlier text\nRequested panel: DEMO-A\nSigned order\nLater text";
  const quote = "Requested panel: DEMO-A\nSigned order";
  const excerpt = evidenceExcerpt(content, quote, 5)!;
  assert.equal(excerpt.quote, quote);
  assert.equal(excerpt.before, "text\n");
  assert.equal(excerpt.after, "\nLate");
  assert.equal(excerpt.clippedStart, true);
  assert.equal(excerpt.clippedEnd, true);
  assert.equal(evidenceExcerpt(content, "Invented passage"), null);
  assert.equal(evidenceExcerpt(content, ""), null);
});

test("long quotes stay complete and boundary excerpts need no ellipses", () => {
  const quote = "x".repeat(800);
  assert.deepEqual(evidenceExcerpt(quote, quote), { before: "", quote, after: "", clippedStart: false, clippedEnd: false });
});

test("conflict evidence includes every candidate while missing fields retain examined sources", async () => {
  for (const id of ["004", "002"]) {
    const bundle = await loadCase(`fixtures/patients/patient-${id}`);
    const result = await analyzeCase(bundle, { runId: "evidence-test", rulesVersion, limits: { ...defaultAnalysisLimits }, model: {
      provider: "test", model: "prepared", async generate() {
        return { text: JSON.stringify(demoProposal(bundle)), completion: "complete", usage: null };
      },
    } });
    assert.equal(result.outcome, "analyzed");
    if (result.outcome !== "analyzed") return;
    const groups = evidenceGroups(result, "issues");
    if (id === "004") {
      assert.deepEqual(groups.find((group) => group.title === "Requested panel")!.citations.map((citation) => citation.quote),
        ["Requested panel: DEMO-A", "Please run DEMO-B."]);
    } else {
      assert.equal(groups[0].citations.length, 0);
      assert.equal(groups[0].examinedSourceIds.length, bundle.sources.length);
    }
  }
});
