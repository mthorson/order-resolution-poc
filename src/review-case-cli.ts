import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resultSchema } from "./result-schema.ts";
import { validateBundle } from "./bundle-integrity.ts";
import { renderReview } from "./review.ts";

const usage = "Usage: npm run review-case -- --result runs/<run-id>/result.json\nOptions: --result <file>  --help, -h";
try {
  const { values, tokens } = parseArgs({ options: {
    result: { type: "string" }, help: { type: "boolean", short: "h" },
  }, strict: true, allowPositionals: false, tokens: true });
  const names = tokens.filter((t) => t.kind === "option").map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("Supply each option only once");
  if (values.help) console.log(usage);
  else {
    if (!values.result?.trim()) throw new Error("--result <file> is required");
    const path = resolve(values.result);
    const result = resultSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const bundle = validateBundle(JSON.parse(await readFile(join(dirname(path), "input.json"), "utf8")));
    console.log(renderReview(result, bundle));
  }
} catch {
  console.error("Could not preview the result; check arguments, saved files, and snapshot integrity");
  console.error(usage);
  process.exitCode = 1;
}
