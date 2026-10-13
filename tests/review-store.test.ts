import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ReviewStore } from "../src/review-store.ts";
import type { ReviewInput } from "../src/review-types.ts";
import { reviewWorkspace } from "./helpers/review-workspace.ts";

test("review decisions preserve original analysis, bind the snapshot, and survive reopening", async () => {
  const workspace = await reviewWorkspace();
  try {
    const store = await ReviewStore.open(workspace.root, workspace.reportPath);
    const summary = (await store.list())[0];
    const detail = await store.detail(summary.runId);
    const resultPath = join(workspace.root, "runs", summary.runId, "result.json");
    const original = await readFile(resultPath, "utf8");
    const input: ReviewInput = { snapshotId: detail.bundle.snapshotId, resultSha256: detail.resultSha256,
      expectedReviewId: null, reviewer: "Test reviewer", decision: "accepted", notes: "Checked synthetic case",
      draftBody: null, evidenceChecked: true };
    const record = await store.save(summary.runId, input);
    assert.equal((await readFile(resultPath, "utf8")), original);
    assert.equal((await (await ReviewStore.open(workspace.root, workspace.reportPath)).detail(summary.runId)).review?.reviewId, record.reviewId);
    await assert.rejects(store.save(summary.runId, input), /changed/);
    const updated = await store.save(summary.runId, { ...input, expectedReviewId: record.reviewId,
      decision: "changes_requested", notes: "Recheck a source" });
    assert.equal(updated.previousReviewId, record.reviewId);
    assert.equal((await store.list())[0].reviewDecision, "changes_requested");
  } finally { await rm(workspace.root, { recursive: true, force: true }); }
});

test("rejects missing reviewer confirmation, unknown runs, and changed source snapshots", async () => {
  const workspace = await reviewWorkspace();
  try {
    const store = await ReviewStore.open(workspace.root, workspace.reportPath);
    const summary = (await store.list())[0];
    const detail = await store.detail(summary.runId);
    const input: ReviewInput = { snapshotId: detail.bundle.snapshotId, resultSha256: detail.resultSha256,
      expectedReviewId: null, reviewer: "Test reviewer", decision: "accepted", notes: "", draftBody: null, evidenceChecked: true };
    await assert.rejects(store.save(summary.runId, { ...input, evidenceChecked: false }));
    await assert.rejects(store.save(summary.runId, { ...input, reviewer: "" }));
    await assert.rejects(store.detail("not-a-run"), /not found/);
    const source = join(workspace.root, "fixtures/patients/patient-001/documents/01-requisition.txt");
    await writeFile(source, (await readFile(source, "utf8")) + "\nCorrected source arrived\n");
    await assert.rejects(store.save(summary.runId, input), /changed/);
  } finally { await rm(workspace.root, { recursive: true, force: true }); }
});
