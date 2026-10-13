import { fork, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { JobStore, type Job } from "./job-store.ts";
import { loadCase } from "./load-case.ts";
import { resultSchema } from "./result-schema.ts";
import { withCaseLock, localCaseLock, processStamp } from "./case-lock.ts";

const codeRoot = fileURLToPath(new URL("../", import.meta.url));
export class JobRunner {
  private child: ChildProcess | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  readonly root: string;
  readonly store: JobStore;
  private readonly publish: (job: Job) => Promise<void>;
  private readonly model: { model: string; region: string } | null;
  private constructor(root: string, store: JobStore, publish: (job: Job) => Promise<void>, model: { model: string; region: string } | null) {
    this.root = root; this.store = store; this.publish = publish; this.model = model;
  }
  static async start(root: string, store: JobStore, publish: (job: Job) => Promise<void>, model: { model: string; region: string } | null = null) {
    if (process.platform !== "linux") throw new Error("The review UI requires Linux process locks. Use the Docker demo on macOS or Windows.");
    const lock = join(root, "runs/.worker-lock");
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const owner: { pid: number; host: string; stamp: string } = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
      if (owner.host !== hostname()) throw new Error("Worker lock belongs to another host; stop that worker before recovery");
      let live = false;
      try { live = await processStamp(owner.pid) === owner.stamp; } catch { /* The previous process is gone. */ }
      if (live) throw new Error("Another worker is active");
      await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
      // Old CLI lock belongs to the terminated worker; never remove a live owner's lock.
      try {
        const caseOwner: { pid: number; stamp?: string } = JSON.parse(await readFile(join(localCaseLock, "owner.json"), "utf8"));
        let sameProcess = false;
        try { sameProcess = !caseOwner.stamp || await processStamp(caseOwner.pid) === caseOwner.stamp; } catch { /* Old process is gone. */ }
        if (!sameProcess) await rm(localCaseLock, { recursive: true });
      } catch { /* No stale CLI lock. */ }
    }
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), stamp: await processStamp(process.pid) }), { mode: 0o600 });
    store.recover();
    const runner = new JobRunner(root, store, publish, model); runner.schedule(); return runner;
  }
  private schedule() { if (!this.stopped) this.timer = setTimeout(() => { this.active = this.tick().finally(() => { this.active = null; this.schedule(); }); }, 250); }
  private async tick() {
    const job = this.store.claim();
    if (!job) return;
    try {
      await withCaseLock(localCaseLock, async () => {
        const bundle = await loadCase(join(this.root, job.caseRoot ?? "fixtures/patients", job.patientFolder));
        if (bundle.snapshotId !== job.snapshotId || bundle.caseId !== job.caseId) throw new Error("snapshot_changed");
        const runDir = join(this.root, "runs", job.runId);
        await mkdir(runDir, { mode: 0o700 });
        await writeFile(join(runDir, "input.json"), JSON.stringify(bundle) + "\n", { mode: 0o600, flag: "wx" });
        const proposal = join(this.root, job.caseRoot && job.caseRoot !== "fixtures/patients" ? job.caseRoot.replace("/patients", "/proposals") : "fixtures/proposals", `${job.patientFolder}.json`);
        const args = ["--run", runDir, ...(job.mode === "playback" ? ["--proposal", proposal] : ["--model", this.model!.model, "--region", this.model!.region])];
        const environment: NodeJS.ProcessEnv = {};
        for (const key of ["PATH", "HOME", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_EC2_METADATA_DISABLED"]) if (process.env[key]) environment[key] = process.env[key];
        const reads = [join(codeRoot, "src"), join(codeRoot, "node_modules"), join(runDir, "input.json"), ...(job.mode === "playback" ? [proposal] : [join(process.env.HOME ?? "/nonexistent", ".aws")])];
        const flags = ["--permission", ...(job.mode === "bedrock" ? ["--allow-net"] : []), ...reads.map((path) => `--allow-fs-read=${path}`), `--allow-fs-write=${runDir}`];
        // No await between this check and fork: cancellation cannot interleave with startup.
        if (this.stopped || this.store.get(job.id).state === "cancelled") return;
        await new Promise<void>((resolve, reject) => {
          const child = this.child = fork(join(codeRoot, "src/case-worker.ts"), args, { execArgv: flags, env: environment,
            stdio: ["ignore", "ignore", "ignore", "ipc"] });
          const timer = setTimeout(() => { child.kill("SIGKILL"); }, 75_000);
          child.once("error", reject);
          child.once("exit", () => { clearTimeout(timer); this.child = null; resolve(); });
        });
        if (this.store.get(job.id).state === "cancelled") return;
        const result = resultSchema.parse(JSON.parse(await readFile(join(runDir, "result.json"), "utf8")));
        if (result.run.runId !== job.runId || result.run.snapshotId !== job.snapshotId) throw new Error("invalid_result");
        await this.publish(job);
        this.store.finish(job.id, result.outcome === "analyzed" ? "succeeded" : "failed", result.outcome === "analysis_failed" ? result.error.code : null);
      });
    } catch (error) {
      if (this.store.get(job.id).state !== "cancelled") this.store.finish(job.id, "failed", error instanceof Error && error.message === "snapshot_changed" ? "snapshot_changed" : "worker_failed");
    }
    console.log(JSON.stringify({ event: "job_finished", status: this.store.get(job.id).state }));
  }
  cancel(id: string) {
    const job = this.store.get(id);
    if (job.state === "running") this.child?.kill("SIGKILL");
    return this.store.finish(id, "cancelled");
  }
  mode(): Job["mode"] { return this.model ? "bedrock" : "playback"; }
  async close() {
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    this.child?.kill("SIGKILL"); await this.active;
    await rm(join(this.root, "runs/.worker-lock"), { recursive: true });
  }
}
