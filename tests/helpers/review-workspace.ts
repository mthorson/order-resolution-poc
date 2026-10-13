import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCase, defaultAnalysisLimits } from "../../src/analyzer.ts";
import { rulesVersion } from "../../src/decision-rules.ts";
import { loadCase } from "../../src/load-case.ts";
import { prepareModelCase } from "../../src/quarantine.ts";
import { demoProposal } from "./demo-proposal.ts";

export async function reviewWorkspace(count = 1) {
  const root = await mkdtemp(join(tmpdir(), "order-review-ui-"));
  const cases = [];
  await mkdir(join(root, "fixtures"), { recursive: true });
  await cp(join(process.cwd(), "fixtures/proposals"), join(root, "fixtures/proposals"), { recursive: true });
  for (let index = 1; index <= count; index++) {
    const patientFolder = `patient-${String(index).padStart(3, "0")}`;
    const folder = join(root, "fixtures/patients", patientFolder);
    await mkdir(join(root, "fixtures/patients"), { recursive: true });
    await cp(join(process.cwd(), "fixtures/patients", patientFolder), folder, { recursive: true });
    const bundle = await loadCase(folder);
    const eligible = prepareModelCase(bundle).modelBundle;
    const proposal = demoProposal(eligible);
    const ids = new Set(eligible.sources.map((s) => s.sourceId));
    proposal.warnings = proposal.warnings.filter((w) => w.evidence.every((e) => ids.has(e.sourceId)));
    const runId = randomUUID();
    const result = await analyzeCase(bundle, { runId, rulesVersion, limits: { ...defaultAnalysisLimits },
      model: { provider: "ui-test", model: "prepared-response", async generate() {
        return { text: JSON.stringify(proposal), completion: "complete", usage: null };
      } } });
    const runDir = join(root, "runs", runId);
    await mkdir(runDir, { recursive: true });
    const resultPath = join(runDir, "result.json");
    await writeFile(resultPath, JSON.stringify(result));
    await writeFile(join(runDir, "input.json"), JSON.stringify(bundle));
    cases.push({ patientFolder, analysis: { resultPath } });
  }
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, JSON.stringify({ cases }));
  return { root, reportPath };
}
