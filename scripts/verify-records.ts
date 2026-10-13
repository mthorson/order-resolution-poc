import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { expectedSchema, scoreCase } from "../src/evaluate.ts";
import { loadCase } from "../src/load-case.ts";
import { resultSchema } from "../src/result-schema.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const datasets = {
  development: { expected: "evals/expected-outcomes.json", sources: "fixtures/patients" },
  "narrative-regression": { expected: "evals/heldout/expected-outcomes.json", sources: "evals/heldout/patients" },
  final: { expected: "evals/final/expected-outcomes.json", sources: "evals/final/patients" },
} as const;
const reportSchema = z.object({
  evalId: z.string(), mode: z.literal("live"), humanReviewGate: z.literal("pending"),
  cases: z.array(z.object({ patientFolder: z.string().regex(/^patient-\d{3}$/),
    analysis: z.object({ passed: z.boolean(), resultPath: z.string() }) })),
});
const usage = "Usage: npm run verify:records -- [--dataset development|narrative-regression|final]";

try {
  const { values, tokens } = parseArgs({ options: { dataset: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true, allowPositionals: false, tokens: true });
  const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate options");
  if (values.help) console.log(usage);
  else {
    if (values.dataset && !Object.hasOwn(datasets, values.dataset)) throw new Error("Unknown dataset");
    const selected = values.dataset ? [values.dataset as keyof typeof datasets] : Object.keys(datasets) as (keyof typeof datasets)[];
    for (const dataset of selected) {
      const directory = join(root, "evals/records", dataset);
      const report = reportSchema.parse(JSON.parse(await readFile(join(directory, "report.json"), "utf8")));
      const expected = expectedSchema.parse(JSON.parse(await readFile(join(root, datasets[dataset].expected), "utf8")));
      if (report.cases.length !== expected.cases.length || new Set(report.cases.map((item) => item.patientFolder)).size !== report.cases.length) {
        throw new Error("Incomplete record");
      }
      const checks = [];
      for (const recorded of report.cases) {
        const answer = expected.cases.find((item) => item.patient_folder === recorded.patientFolder);
        if (!answer || recorded.analysis.resultPath !== `${recorded.patientFolder}.json`) throw new Error("Unexpected record path");
        const bundle = await loadCase(join(root, datasets[dataset].sources, recorded.patientFolder));
        const result = resultSchema.parse(JSON.parse(await readFile(join(directory, recorded.analysis.resultPath), "utf8")));
        const score = scoreCase(result, answer, bundle);
        checks.push({ caseId: answer.case_id, recordedPass: recorded.analysis.passed, currentPass: score.passed, checks: score.checks });
        if (score.passed !== recorded.analysis.passed) process.exitCode = 1;
      }
      console.log(JSON.stringify({ dataset, evalId: report.evalId, mode: "saved-live-results",
        currentPassed: checks.filter((item) => item.currentPass).length, total: checks.length,
        humanReview: "pending", cases: checks }, null, 2));
    }
  }
} catch {
  console.error("Could not verify saved synthetic records. Check the dataset, files, and schemas.");
  console.error(usage); process.exitCode = 1;
}
