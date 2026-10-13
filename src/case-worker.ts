import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { analyzeCase, defaultAnalysisLimits, type ModelAdapter } from "./analyzer.ts";
import { createBedrockAdapter } from "./bedrock.ts";
import { validateBundle } from "./bundle-integrity.ts";
import { rulesVersion } from "./decision-rules.ts";

// A fresh process sees only the selected immutable input and its run directory.
const { values } = parseArgs({ options: { run: { type: "string" }, model: { type: "string" },
  region: { type: "string" }, proposal: { type: "string" } }, strict: true, allowPositionals: false });
const directory = values.run!;
let bedrock: ReturnType<typeof createBedrockAdapter> | null = null;
let finished = false;
process.on("disconnect", () => { if (!finished) process.exit(1); });
try {
  const bundle = validateBundle(JSON.parse(await readFile(join(directory, "input.json"), "utf8")));
  bedrock = values.proposal ? null : createBedrockAdapter(values.region!, values.model!);
  const base: ModelAdapter = bedrock?.adapter ?? { provider: "local-playback", model: "prepared-response",
    async generate() { return { text: await readFile(values.proposal!, "utf8"), completion: "complete", usage: null }; } };
  const save = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  const recording: ModelAdapter = { provider: base.provider, model: base.model, async generate(request) {
    await save("request.json", { instructions: request.instructions, caseBundle: request.caseBundle, maxOutputTokens: request.maxOutputTokens });
    const response = await base.generate(request); await save("response.json", response); return response;
  } };
  const result = await analyzeCase(bundle, { runId: directory.split(/[\\/]/).at(-1)!, rulesVersion,
    limits: { ...defaultAnalysisLimits, maxInputBytes: 64 * 1024 }, model: recording });
  await save("result.json", result);
  process.exitCode = result.outcome === "analyzed" ? 0 : 1;
} catch { process.exitCode = 1; }
finally { bedrock?.close(); finished = true; process.disconnect?.(); }
