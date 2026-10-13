import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { sha256 } from "./bundle-integrity.ts";
import { expectedSchema, scoreBaseline, scoreCase } from "./evaluate.ts";
import { loadCase } from "./load-case.ts";
import { resultSchema } from "./result-schema.ts";
import { rulesBaseline } from "./rules-baseline.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const usage = `Usage: npm run evaluate -- --playback
Live: npm run evaluate -- --profile <profile> --region <region> --model <model-id>
Options: --dataset development|heldout|final  --playback  --profile  --region  --model  --help, -h`;
const summarySchema = z.object({ resultPath: z.string().min(1) });

async function main() {
  const { values, tokens } = parseArgs({ options: {
    dataset: { type: "string" }, playback: { type: "boolean" }, profile: { type: "string" }, region: { type: "string" },
    model: { type: "string" }, help: { type: "boolean", short: "h" },
  }, strict: true, allowPositionals: false, tokens: true });
  const names = tokens.filter((t) => t.kind === "option").map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("Supply each option only once");
  if (values.help) { console.log(usage); return; }
  if (values.playback ? [values.profile, values.region, values.model].some((v) => v !== undefined)
    : [values.profile, values.region, values.model].some((v) => !v?.trim())) {
    throw new Error("Choose --playback alone, or supply --profile, --region, and --model");
  }
  const dataset = values.dataset ?? "development";
  if (!["development", "heldout", "final"].includes(dataset)) throw new Error("Choose development, heldout, or final dataset");
  const caseRoot = dataset === "development" ? "fixtures/patients" : `evals/${dataset}/patients`;
  const proposalRoot = dataset === "development" ? "fixtures/proposals" : `evals/${dataset}/proposals`;
  const expectedText = await readFile(join(root, dataset === "development" ? "evals/expected-outcomes.json" : `evals/${dataset}/expected-outcomes.json`), "utf8");
  const expected = expectedSchema.parse(JSON.parse(expectedText));
  if (new Set(expected.cases.map((c) => c.patient_folder)).size !== expected.cases.length) {
    throw new Error("Duplicate evaluation case");
  }
  const evalId = randomUUID();
  const parent = join(root, "runs/evaluations");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const evalDir = join(parent, evalId);
  await mkdir(evalDir, { mode: 0o700 });
  const cases = [];
  let stopped = false;
  for (const item of expected.cases) {
    const folder = join(root, caseRoot, item.patient_folder);
    const bundle = await loadCase(folder);
    const baseline = rulesBaseline(bundle);
    const args = [join(root, "src/analyze-case-cli.ts"), "--case", folder];
    if (values.playback) args.push("--proposal", join(root, proposalRoot, `${item.patient_folder}.json`));
    else args.push("--region", values.region!, "--model", values.model!);
    let stdout: string;
    try {
      ({ stdout } = await exec(process.execPath, args, { cwd: root, timeout: 90000,
        env: { ...process.env, ...(values.profile ? { AWS_PROFILE: values.profile } : {}) } }));
    } catch (error) {
      if (!(error instanceof Error && "stdout" in error && typeof error.stdout === "string" && error.stdout.trim())) {
        cases.push({ patientFolder: item.patient_folder, snapshotId: bundle.snapshotId,
          baseline: { ...scoreBaseline(baseline, item), durationMs: baseline.durationMs },
          analysis: { passed: false, failureCode: "runner_error" },
          humanReview: { status: "pending", checks: item.review_checks, reviewerSeconds: null } });
        stopped = true;
        break; // A killed worker may still hold the lock; don't launch the next case.
      }
      stdout = error.stdout;
    }
    const summary = summarySchema.parse(JSON.parse(stdout));
    const runDir = dirname(summary.resultPath);
    if (dirname(runDir) !== join(root, "runs")) throw new Error("Unexpected saved run location");
    const result = resultSchema.parse(JSON.parse(await readFile(summary.resultPath, "utf8")));
    cases.push({ patientFolder: item.patient_folder, snapshotId: bundle.snapshotId,
      baseline: { ...scoreBaseline(baseline, item), durationMs: baseline.durationMs },
      analysis: { ...scoreCase(result, item, bundle), resultPath: summary.resultPath,
        durationMs: result.run.durationMs, usage: result.run.usage, estimatedCostUsd: result.run.estimatedCostUsd },
      humanReview: { status: "pending", checks: item.review_checks, reviewerSeconds: null } });
  }
  const automatedPassed = cases.filter((c) => c.analysis.passed).length;
  const baselinePassed = cases.filter((c) => c.baseline.passed).length;
  const report = {
    schemaVersion: "evaluation.v1", evalId, createdAt: new Date().toISOString(),
    dataset, caseRoot, mode: values.playback ? "playback" : "live", rulesVersion: expected.rules_version,
    expectedOutcomesSha256: sha256(expectedText), model: values.model ?? "prepared-response",
    region: values.region ?? null,
    automatedGate: automatedPassed === expected.cases.length ? "passed" : "failed",
    humanReviewGate: "pending", stopped,
    totals: { expected: expected.cases.length, evaluated: cases.length, automatedPassed, baselinePassed },
    notRun: expected.cases.slice(cases.length).map((c) => c.patient_folder), cases,
  };
  const reportPath = join(evalDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ mode: report.mode, automatedGate: report.automatedGate,
    humanReviewGate: report.humanReviewGate, totals: report.totals, reportPath }, null, 2));
  if (report.automatedGate === "failed") process.exitCode = 1;
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error && /^(Supply|Choose|Duplicate|Unexpected)/.test(error.message)
    ? error.message : "Evaluation failed; check fixtures, worker locks, and saved run artifacts");
  console.error(usage);
  process.exitCode = 1;
}
