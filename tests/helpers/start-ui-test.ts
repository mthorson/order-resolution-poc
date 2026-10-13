import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { startReviewServer } from "../../src/ui-server.ts";
import { reviewWorkspace } from "./review-workspace.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "3011" } }, strict: true, allowPositionals: false });
const workspace = await reviewWorkspace(5);
const app = await startReviewServer(workspace.root, workspace.reportPath, Number(values.port), { frontendRoot: process.cwd() });
console.log(`UI test workspace: ${app.origin}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void app.close().then(() => rm(workspace.root, { recursive: true, force: true }));
});
