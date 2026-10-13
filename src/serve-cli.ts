import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { startReviewServer } from "./ui-server.ts";
import { oidcProvider } from "./oidc-provider.ts";
import { parseAccessPolicy } from "./access-policy.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = "Usage: npm run serve -- (--report <file> | --demo) [--port <port>] [--host <address>] [--origin <http(s)-origin>] [--auth demo|oidc] [--access <policy.json>]";
try {
  const { values, tokens } = parseArgs({ options: {
    report: { type: "string" }, demo: { type: "boolean" }, port: { type: "string" },
    host: { type: "string" }, origin: { type: "string" }, help: { type: "boolean", short: "h" },
    auth: { type: "string" }, access: { type: "string" },
    jobs: { type: "string" }, model: { type: "string" }, region: { type: "string" },
  }, strict: true, allowPositionals: false, tokens: true });
  const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate options");
  if (values.help) console.log(usage);
  else {
    if (process.platform !== "linux") throw new Error("The review UI requires Linux process locks. Use the Docker demo on macOS or Windows.");
    if (Boolean(values.report?.trim()) === Boolean(values.demo)) throw new Error("Choose a report or demo");
    const port = Number(values.port ?? "3000");
    const host = values.host ?? "127.0.0.1";
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !["127.0.0.1", "0.0.0.0"].includes(host)) throw new Error("Invalid address");
    if (host === "0.0.0.0" && !values.origin) throw new Error("Supply the public origin");
    const mode = values.auth ?? "demo";
    const jobMode = values.jobs ?? "playback";
    if (!["playback", "bedrock"].includes(jobMode) || (jobMode === "bedrock" && (!values.model?.trim() || !values.region?.trim()))) throw new Error("Configure the job model");
    if (jobMode === "playback" && (values.model || values.region)) throw new Error("Model settings require Bedrock jobs");
    if (!["demo", "oidc"].includes(mode)) throw new Error("Unknown authentication mode");
    if (mode === "demo" && values.access) throw new Error("Access policy requires sign-in");
    if (values.origin) {
      const origin = new URL(values.origin);
      if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid origin");
      if (mode === "demo" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("Demo access is local only");
      if (mode === "oidc" && origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("Use HTTPS for sign-in");
    }
    if (mode === "oidc" && (!values.origin || !values.access || !process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID)) throw new Error("Sign-in configuration is incomplete");
    const accessPath = values.access ? resolve(values.access) : null;
    if (accessPath) parseAccessPolicy(JSON.parse(await readFile(accessPath, "utf8")));
    await readFile(join(root, "dist/index.html"));
    const authentication = mode === "oidc" ? { accessPath: accessPath!, provider: await oidcProvider({
      issuer: process.env.OIDC_ISSUER!, clientId: process.env.OIDC_CLIENT_ID!, clientSecret: process.env.OIDC_CLIENT_SECRET,
    }) } : undefined;
    const reportPath = values.report ? resolve(values.report) : join(root, "runs/demo-report.json");
    if (values.demo) {
      let exists = true;
      try { await readFile(reportPath); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") exists = false;
        else throw error;
      }
      if (!exists) {
        // Seed synthetic playback once; restarts keep the same queue and reviews.
        const { stdout } = await promisify(execFile)(process.execPath, [join(root, "src/evaluate-cli.ts"), "--playback"], { cwd: root, timeout: 90000 });
        const evaluation: { reportPath: string } = JSON.parse(stdout);
        await mkdir(join(root, "runs"), { recursive: true, mode: 0o700 });
        await writeFile(reportPath, await readFile(evaluation.reportPath), { mode: 0o600, flag: "wx" });
      }
    }
    const app = await startReviewServer(root, reportPath, port, {
      frontend: "built", host: host as "127.0.0.1" | "0.0.0.0", publicOrigin: values.origin,
      authentication,
      jobModel: jobMode === "bedrock" ? { model: values.model!, region: values.region! } : undefined,
    });
    console.log(`Case review: ${values.origin ?? app.origin}\nSynthetic demo. Jobs: ${jobMode}. No external messages are sent.`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      void app.close().then(() => { process.exitCode = 0; });
    });
  }
} catch (error) {
  if (error instanceof Error && error.message.startsWith("The review UI requires Linux")) console.error(error.message);
  console.error("Could not start the built UI. Check the build, saved report, source snapshots, port, and origin.");
  console.error(usage); process.exitCode = 1;
}
