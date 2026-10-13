import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyzeCase, defaultAnalysisLimits, ModelInvocationError, type ModelAdapter } from "./analyzer.ts";
import { createBedrockAdapter } from "./bedrock.ts";
import { localCaseLock, withCaseLock } from "./case-lock.ts";
import { rulesVersion } from "./decision-rules.ts";
import { loadCase } from "./load-case.ts";

const usage = `Usage: npm run analyze-case -- --case <folder> --model <model-id> --region <region>
Playback: npm run analyze-case -- --case <folder> --proposal <json-file>
Options: --case, -c  --model  --region  --proposal  --help, -h`;

async function main() {
  const { values, tokens } = parseArgs({
    options: {
      case: { type: "string", short: "c" }, model: { type: "string" },
      region: { type: "string" }, proposal: { type: "string" }, help: { type: "boolean", short: "h" },
    }, strict: true, allowPositionals: false, tokens: true,
  });
  const names = tokens.filter((t) => t.kind === "option").map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("Supply each option only once");
  if (values.help) { console.log(usage); return; }
  const folder = values.case;
  if (!folder?.trim()) throw new Error("--case <folder> is required");
  if (values.proposal !== undefined) {
    if (!values.proposal.trim() || values.model !== undefined || values.region !== undefined) {
      throw new Error("Playback requires --proposal and cannot include --model or --region");
    }
  } else if (!values.model?.trim() || !values.region?.trim()) {
    throw new Error("Live analysis requires --model and --region");
  }

  await withCaseLock(localCaseLock, async () => {
    const bundle = await loadCase(folder);
    const runId = randomUUID();
    const root = fileURLToPath(new URL("../runs/", import.meta.url));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const runDir = join(root, runId);
    await mkdir(runDir, { mode: 0o700 });
    async function save(name: string, value: unknown) {
      await writeFile(join(runDir, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    }
    await save("input.json", bundle);
    const bedrock = values.proposal ? null : createBedrockAdapter(values.region!, values.model!);
    const base: ModelAdapter = bedrock?.adapter ?? {
      provider: "local-playback", model: "prepared-response",
      async generate() {
        return { text: await readFile(values.proposal!, "utf8"), completion: "complete", usage: null };
      },
    };
    const recording: ModelAdapter = {
      provider: base.provider, model: base.model,
      async generate(request) {
        await save("request.json", { instructions: request.instructions, caseBundle: request.caseBundle,
          maxOutputTokens: request.maxOutputTokens });
        try {
          const response = await base.generate(request);
          await save("response.json", response);
          return response;
        } catch (error) {
          if (error instanceof ModelInvocationError) await save("provider-error.json", { message: error.message });
          throw error;
        }
      },
    };
    try {
      const result = await analyzeCase(bundle, { runId, rulesVersion, limits: { ...defaultAnalysisLimits }, model: recording });
      await save("result.json", result);
      console.log(JSON.stringify({ outcome: result.outcome,
        ...(result.outcome === "analyzed" ? { status: result.status } : { error: result.error.code }),
        resultPath: join(runDir, "result.json") }, null, 2));
      if (result.outcome === "analysis_failed") process.exitCode = 1;
    } finally { bedrock?.close(); }
  });
}

try { await main(); }
catch (error) {
  // Runtime errors may contain source text, paths, or vendor details.
  console.error(error instanceof Error && /^(Supply|--case|Playback|Live analysis|Another case)/.test(error.message)
    ? error.message : "Run failed; check input files, saved run artifacts, and local permissions");
  console.error(usage);
  process.exitCode = 1;
}
