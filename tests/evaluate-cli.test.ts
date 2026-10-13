import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const run = (...args: string[]) => exec(process.execPath, ["src/evaluate-cli.ts", ...args]);

test("five-case playback produces a private report with human review still pending", async () => {
  const { stdout } = await run("--playback");
  const summary = JSON.parse(stdout);
  assert.equal(summary.mode, "playback");
  assert.equal(summary.automatedGate, "passed");
  assert.equal(summary.humanReviewGate, "pending");
  assert.deepEqual(summary.totals, { expected: 5, evaluated: 5, automatedPassed: 5, baselinePassed: 5 });
  const report = JSON.parse(await readFile(summary.reportPath, "utf8"));
  assert.equal(dirname(dirname(summary.reportPath)), join(process.cwd(), "runs/evaluations"));
  assert.equal((await stat(summary.reportPath)).mode & 0o777, 0o600);
  try {
    assert.deepEqual(report.notRun, []);
    for (const item of report.cases) {
      assert.equal(item.humanReview.status, "pending");
      assert.equal(item.humanReview.reviewerSeconds, null);
      const result = JSON.parse(await readFile(item.analysis.resultPath, "utf8"));
      assert.equal(result.run.provider, "local-playback");
      assert.equal(dirname(dirname(item.analysis.resultPath)), join(process.cwd(), "runs"));
    }
  } finally {
    for (const item of report.cases) await rm(dirname(item.analysis.resultPath), { recursive: true });
    await rm(dirname(summary.reportPath), { recursive: true });
  }
});

test("evaluation rejects missing, mixed, unknown, and duplicated options", async () => {
  assert.match((await run("--help")).stdout, /Live:/);
  for (const args of [[], ["--playback", "--model", "unused"], ["--unknown"],
    ["--playback", "--playback"], ["--region", "us-west-2", "--model", "unused"]]) {
    await assert.rejects(run(...args));
  }
});
