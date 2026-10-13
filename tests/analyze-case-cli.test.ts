import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const run = (...args: string[]) => exec(process.execPath, ["src/analyze-case-cli.ts", ...args]);

test("playback saves the raw response and validated result in private run files", async () => {
  const { stdout } = await run("--proposal", "fixtures/proposals/complete-case.json", "--case", "fixtures/patients/patient-001");
  const summary = JSON.parse(stdout);
  assert.equal(summary.outcome, "analyzed");
  assert.equal(summary.status, "ready_for_review");
  const runDir = dirname(summary.resultPath);
  assert.equal(dirname(runDir), join(process.cwd(), "runs"));
  assert.match(basename(runDir), /^[a-f0-9-]{36}$/);
  try {
    const result = JSON.parse(await readFile(summary.resultPath, "utf8"));
    assert.equal(result.run.provider, "local-playback");
    assert.equal(result.actionState, "not_executed");
    assert.equal(result.run.modelCalls, 1);
    assert.equal((await stat(runDir)).mode & 0o777, 0o700);
    for (const name of ["input.json", "request.json", "response.json", "result.json"]) {
      assert.equal((await stat(join(runDir, name))).mode & 0o777, 0o600);
    }
    const response = JSON.parse(await readFile(join(runDir, "response.json"), "utf8"));
    assert.deepEqual(JSON.parse(response.text), JSON.parse(await readFile("fixtures/proposals/complete-case.json", "utf8")));
    assert.doesNotMatch(stdout, /Alex Example|SYN-001/);
  } finally { await rm(runDir, { recursive: true }); }
});

test("invalid named options fail before any cloud call", async () => {
  const { stdout } = await run("--help");
  assert.match(stdout, /Playback:/);
  for (const args of [[], ["--case", "fixtures/patients/patient-001"],
    ["--unknown"], ["--case", "a", "--case", "b"],
    ["--case", "a", "--proposal", "b", "--model", "c"]]) {
    await assert.rejects(run(...args), (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error && "stdout" in error);
      assert.match(String(error.stderr), /Usage:/);
      assert.equal(error.stdout, "");
      return true;
    });
  }
});
