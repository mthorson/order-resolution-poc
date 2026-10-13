import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { summarizeMetrics } from "../src/metrics.ts";
import { ReviewStore } from "../src/review-store.ts";
import { reviewWorkspace } from "./helpers/review-workspace.ts";

test("metrics distinguish replay, missing prices, version scope, and recorded review time", async () => {
  const workspace = await reviewWorkspace();
  try {
    const store = await ReviewStore.open(workspace.root, workspace.reportPath);
    const detail = await store.detail((await store.list())[0].runId);
    detail.result.run.provider = "local-playback";
    const metrics = summarizeMetrics([detail], []);
    assert.equal(metrics.modelCalls, 0);
    assert.equal(metrics.estimatedCostUsd, null);
    assert.equal(metrics.medianReviewMs, null);
    assert.equal(metrics.pendingReview, 1);
    assert.equal(metrics.versions.length, 1);
    detail.result.run.provider = "bedrock";
    detail.result.run.usage = { inputTokens: 50, outputTokens: 25 };
    const live = summarizeMetrics([detail], []);
    assert.equal(live.modelCalls, 1);
    assert.equal(live.inputTokens, 50);
    assert.equal(live.outputTokens, 25);
  } finally { await rm(workspace.root, { recursive: true, force: true }); }
});
