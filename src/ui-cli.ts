import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startReviewServer } from "./ui-server.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = "Usage: npm run ui -- [--report <evaluation-report.json>] [--port <port>]\nOptions: --report  --port  --help, -h";
async function latestReport() {
  const parent = join(root, "runs/evaluations");
  const candidates = [];
  for (const folder of await readdir(parent)) {
    if (!/^[a-f0-9-]{36}$/.test(folder)) continue;
    const path = join(parent, folder, "report.json");
    try {
      const report = JSON.parse(await readFile(path, "utf8"));
      if (report.cases?.every((item: { analysis?: { resultPath?: string } }) => item.analysis?.resultPath)) {
        candidates.push({ path, live: report.mode === "live", createdAt: String(report.createdAt) });
      }
    } catch { /* Ignore incomplete evaluations. */ }
  }
  candidates.sort((a, b) => Number(b.live) - Number(a.live) || b.createdAt.localeCompare(a.createdAt));
  if (!candidates.length) throw new Error("No saved evaluation. Run npm run evaluate -- --playback first");
  return candidates[0].path;
}

try {
  const { values, tokens } = parseArgs({ options: { report: { type: "string" }, port: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true, allowPositionals: false, tokens: true });
  const names = tokens.filter((t) => t.kind === "option").map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("Supply each option only once");
  if (values.help) console.log(usage);
  else {
    if (process.platform !== "linux") throw new Error("The review UI requires Linux process locks. Use the Docker demo on macOS or Windows.");
    const port = Number(values.port ?? "3000");
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535");
    const app = await startReviewServer(root, values.report ? resolve(values.report) : await latestReport(), port);
    console.log(`Case review: ${app.origin}\nSynthetic data only. No model calls or messages are sent from this UI.`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
  }
} catch (error) {
  if (error instanceof Error && error.message.startsWith("The review UI requires Linux")) console.error(error.message);
  console.error("Could not start the UI. Check the report, port, and saved run files.");
  console.error(usage); process.exitCode = 1;
}
