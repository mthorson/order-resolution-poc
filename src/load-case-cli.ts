import { parseArgs } from "node:util";
import { loadCase } from "./load-case.ts";
import { localCaseLock, withCaseLock } from "./case-lock.ts";

const usage = "Usage: npm run load-case -- --case fixtures/patients/patient-001\nOptions: --case, -c <folder>   --help, -h";

try {
  const { values, tokens } = parseArgs({
    options: {
      case: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  if (tokens.filter((token) => token.kind === "option" && token.name === "case").length > 1) {
    throw new Error("Supply --case only once");
  }
  if (values.help) {
    console.log(usage);
  } else {
    if (!values.case?.trim()) throw new Error("--case <folder> is required");
    const folder = values.case;
    await withCaseLock(localCaseLock, async () => {
      console.log(JSON.stringify(await loadCase(folder), null, 2));
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not load case");
  console.error(usage);
  process.exitCode = 1;
}
