import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, restore, cleanup } from "./maintenance.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const usage = "Usage: npm run maintain -- --action backup|restore|cleanup [--destination <folder>] [--source <backup>] [--days <number>] [--apply]";
try {
  const { values } = parseArgs({ options: { action: { type: "string" }, destination: { type: "string" },
    source: { type: "string" }, days: { type: "string" }, apply: { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false });
  if (values.help) console.log(usage);
  else if (values.action === "backup" && values.destination && !values.source && !values.apply) console.log(JSON.stringify(await backup(root, resolve(values.destination))));
  else if (values.action === "restore" && values.source && !values.destination && !values.apply) console.log(JSON.stringify(await restore(resolve(values.source), root)));
  else if (values.action === "cleanup" && !values.source && !values.destination) console.log(JSON.stringify(await cleanup(root, Number(values.days ?? "30"), values.apply)));
  else throw new Error("Invalid maintenance options");
} catch (error) {
  console.error(error instanceof Error && /^(Stop|Keep|Unsafe|Backup|Duplicate|Existing|Restore|Retention)/.test(error.message) ? error.message : "Maintenance failed; check options and storage");
  console.error(usage); process.exitCode = 1;
}
