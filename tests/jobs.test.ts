import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { JobStore } from "../src/job-store.ts";
import { JobRunner } from "../src/job-runner.ts";
import { ReviewStore } from "../src/review-store.ts";
import { loadCase } from "../src/load-case.ts";
import { reviewWorkspace } from "./helpers/review-workspace.ts";

const input = { caseId: "CASE-001", patientFolder: "patient-001", snapshotId: "a".repeat(64), mode: "playback" as const };
test("durable requests are idempotent and two database connections cannot claim simultaneous jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-store-"));
  const first = new JobStore(directory), second = new JobStore(directory);
  try {
    const key = randomUUID();
    const job = first.enqueue(input, "user", key);
    assert.equal(second.enqueue(input, "user", key).id, job.id);
    assert.throws(() => second.enqueue({ ...input, snapshotId: "b".repeat(64) }, "user", key), /another request/);
    const alias = randomUUID();
    assert.equal(second.enqueue(input, "other", alias).id, job.id);
    const later = first.enqueue({ ...input, caseId: "CASE-002", patientFolder: "patient-002" }, "user", randomUUID());
    assert.equal(first.claim()!.id, job.id);
    assert.equal(second.claim(), null);
    first.finish(job.id, "succeeded");
    assert.equal(second.enqueue(input, "other", alias).id, job.id);
    assert.equal(second.claim()!.id, later.id);
    second.recover();
    assert.equal(first.get(later.id).error, "interrupted");
    assert.equal(first.verifyAudit(), true);
    first.db.prepare("UPDATE audit SET data='{}' WHERE id=1").run();
    assert.equal(second.verifyAudit(), false);
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});

test("fresh workers persist new runs, reject overlapping runners, and leave original evaluations untouched", async () => {
  const workspace = await reviewWorkspace();
  const original = await readFile(workspace.reportPath, "utf8");
  const reviews = await ReviewStore.open(workspace.root, workspace.reportPath);
  const jobs = new JobStore(join(workspace.root, "runs"));
  const runner = await JobRunner.start(workspace.root, jobs, (job) => reviews.register(job.runId, job.patientFolder));
  try {
    await assert.rejects(JobRunner.start(workspace.root, jobs, async () => {}), /Another worker/);
    const bundle = await loadCase(join(workspace.root, "fixtures/patients/patient-001"));
    const job = jobs.enqueue({ ...input, snapshotId: bundle.snapshotId }, "demo", randomUUID());
    const deadline = Date.now() + 8000;
    while (["queued", "running"].includes(jobs.get(job.id).state) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(jobs.get(job.id).state, "succeeded");
    assert.equal((await reviews.list())[0].runId, job.runId);
    const reopened = await ReviewStore.open(workspace.root, workspace.reportPath);
    assert.equal((await reopened.list())[0].runId, job.runId);
    assert.equal(await readFile(workspace.reportPath, "utf8"), original);
    const source = join(workspace.root, "fixtures/patients/patient-001/documents/01-requisition.txt");
    await writeFile(source, (await readFile(source, "utf8")) + "\nNew attachment note.\n");
    assert.equal((await reviews.detail(job.runId)).sourceState, "changed");
    const stale = jobs.enqueue({ ...input, snapshotId: bundle.snapshotId }, "demo", randomUUID());
    const stop = Date.now() + 5000;
    while (["queued", "running"].includes(jobs.get(stale.id).state) && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(jobs.get(stale.id).error, "snapshot_changed");
  } finally { await runner.close(); jobs.close(); await rm(workspace.root, { recursive: true, force: true }); }
});



test("cancelling during input preparation prevents worker startup", async () => {
  const workspace = await reviewWorkspace();
  const jobs = new JobStore(join(workspace.root, "runs"));
  let published = false;
  const runner = await JobRunner.start(workspace.root, jobs, async () => { published = true; });
  try {
    const bundle = await loadCase(join(workspace.root, "fixtures/patients/patient-001"));
    const job = jobs.enqueue({ ...input, snapshotId: bundle.snapshotId }, "demo", randomUUID());
    let notify!: () => void;
    const cancellationChecked = new Promise<void>((resolve) => { notify = resolve; });
    const get = jobs.get.bind(jobs);
    jobs.get = (id) => {
      const current = get(id);
      if (id === job.id && current.state === "cancelled") notify();
      return current;
    };
    const claim = jobs.claim.bind(jobs);
    jobs.claim = () => {
      const next = claim();
      if (next) queueMicrotask(() => { runner.cancel(next.id); });
      return next;
    };
    await cancellationChecked;
    assert.equal(jobs.get(job.id).state, "cancelled");
    assert.equal(published, false);
    await assert.rejects(readFile(join(workspace.root, "runs", job.runId, "result.json")), { code: "ENOENT" });
  } finally { await runner.close(); jobs.close(); await rm(workspace.root, { recursive: true, force: true }); }
});
