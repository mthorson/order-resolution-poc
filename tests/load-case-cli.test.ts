import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const run = (...args: string[]) => exec(process.execPath, ["src/load-case-cli.ts", ...args]);
const folder = "fixtures/patients/patient-001";

test("loads a case using long, short, and equals-form flags", async () => {
  for (const args of [["--case", folder], ["-c", folder], [`--case=${folder}`]]) {
    const { stdout, stderr } = await run(...args);
    assert.equal(JSON.parse(stdout).caseId, "CASE-001");
    assert.equal(stderr, "");
  }
});

test("help works without a case and in either option order", async () => {
  for (const args of [["--help"], ["-h"], ["--help", "--case", folder], ["--case", folder, "--help"]]) {
    const { stdout } = await run(...args);
    assert.match(stdout, /Usage:/);
    assert.doesNotMatch(stdout, /snapshotId/);
  }
});

test("rejects missing values, unknown flags, positionals, and repeated cases", async () => {
  for (const args of [[], ["--case"], ["--case="], ["--case", " "],
    ["--unknown"], [folder], ["--case", folder, "-c", folder]]) {
    await assert.rejects(run(...args), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error && "stdout" in error);
      assert.equal(error.code, 1);
      assert.match(String(error.stderr), /Usage:/);
      assert.equal(error.stdout, "");
      return true;
    });
  }
});
