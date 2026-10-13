import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { backup, restore, cleanup } from "../src/maintenance.ts";
import { ReviewStore } from "../src/review-store.ts";
import { JobStore } from "../src/job-store.ts";
import { reviewWorkspace } from "./helpers/review-workspace.ts";

test("backup and relocation restore preserve snapshots, review records, and audit integrity", async () => {
  const workspace = await reviewWorkspace();
  const parent = await mkdtemp(join(tmpdir(), "review-backup-"));
  const destination = join(parent, "snapshot");
  const restored = join(parent, "restored");
  try {
    const report = join(workspace.root, "runs/evaluations/test/report.json");
    await mkdir(join(workspace.root, "runs/evaluations/test"), { recursive: true });
    await writeFile(report, await readFile(workspace.reportPath));
    const store = await ReviewStore.open(workspace.root, report);
    const item = (await store.list())[0];
    const detail = await store.detail(item.runId);
    const reviewed = await store.save(item.runId, { snapshotId: detail.bundle.snapshotId, resultSha256: detail.resultSha256,
      expectedReviewId: null, reviewer: "Backup test", decision: "accepted", notes: "", draftBody: null, evidenceChecked: true });
    const audit = new JobStore(join(workspace.root, "runs"));
    audit.audit("backup_test", "test", "CASE-001", reviewed.reviewId); audit.close();
    assert.ok((await backup(workspace.root, destination)).files > 0);
    await mkdir(restored);
    await restore(destination, restored);
    const restoredStore = await ReviewStore.open(restored, join(restored, "runs/evaluations/test/report.json"));
    assert.equal((await restoredStore.detail(item.runId)).review!.reviewId, reviewed.reviewId);
    assert.equal((await restoredStore.detail(item.runId)).sourceState, "current");
    const restoredAudit = new JobStore(join(restored, "runs"));
    assert.equal(restoredAudit.verifyAudit(), true); restoredAudit.close();
    await writeFile(join(destination, "fixtures/patients/patient-001/documents/01-requisition.txt"), "tampered");
    const badTarget = join(parent, "bad"); await mkdir(badTarget);
    await assert.rejects(restore(destination, badTarget), /integrity/);
    await assert.rejects(readFile(join(badTarget, "runs/evaluations/test/report.json")), /ENOENT/);
    const orphan = randomUUID(); await mkdir(join(workspace.root, "runs", orphan));
    await utimes(join(workspace.root, "runs", orphan), new Date(0), new Date(0));
    assert.deepEqual((await cleanup(workspace.root, 30)).eligibleRunIds, [orphan]);
    await cleanup(workspace.root, 30, true);
    assert.equal((await store.detail(item.runId)).review!.reviewId, reviewed.reviewId);
  } finally { await rm(workspace.root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); }
});
