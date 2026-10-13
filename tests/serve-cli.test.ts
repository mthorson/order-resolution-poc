import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
test("built-server CLI has named options and rejects invalid inputs before starting", async () => {
  const { stdout } = await exec(process.execPath, ["src/serve-cli.ts", "--help"]);
  assert.match(stdout, /--report.*--demo/);
  for (const args of [[], ["some-report.json"], ["--unknown"], ["--demo", "--report", "report.json"],
    ["--demo", "--host", "0.0.0.0"], ["--demo", "--port", "80"],
    ["--demo", "--origin", "https://example.com/path"], ["--demo", "--origin", "not-a-url"],
    ["--demo", "--auth", "oidc"], ["--demo", "--auth", "unknown"],
    ["--demo", "--origin", "https://public.example"], ["--demo", "--access", "config/access.example.json"],
    ["--demo", "--demo"]]) {
    await assert.rejects(exec(process.execPath, ["src/serve-cli.ts", ...args]), (error: unknown) =>
      error instanceof Error && "stderr" in error && String(error.stderr).includes("Could not start the built UI"));
  }
});
