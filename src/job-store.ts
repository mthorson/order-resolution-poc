import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./bundle-integrity.ts";

export type Job = {
  id: string; caseId: string; patientFolder: string; snapshotId: string; runId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  mode: "playback" | "bedrock"; createdAt: string; updatedAt: string;
  error: string | null; attempts: number;
  caseRoot?: "fixtures/patients" | "evals/heldout/patients" | "evals/final/patients";
};
type Row = { data: string; fingerprint: string };
export class JobStore {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "operations.sqlite");
    this.db = new DatabaseSync(path, { timeout: 5000 });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, actor TEXT NOT NULL, request_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(actor,request_key)) STRICT;
      CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(actor,request_key)) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_job ON jobs(state) WHERE state='running';
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, data TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL) STRICT;`);
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = run(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  enqueue(input: Pick<Job, "caseId" | "patientFolder" | "snapshotId" | "mode" | "caseRoot">, actor: string, requestKey: string): Job {
    if (!/^[a-f0-9-]{36}$/.test(requestKey)) throw new Error("Supply an idempotency key");
    return this.transaction(() => {
      const fingerprint = sha256(JSON.stringify(input));
      const old = this.db.prepare("SELECT j.data,r.fingerprint FROM requests r JOIN jobs j ON j.id=r.job_id WHERE r.actor=? AND r.request_key=?").get(actor, requestKey) as Row | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error("Idempotency key belongs to another request");
        return JSON.parse(old.data) as Job;
      }
      const duplicate = (this.db.prepare("SELECT data FROM jobs WHERE fingerprint=? AND state IN ('queued','running')").get(fingerprint) as Row | undefined);
      if (duplicate) {
        const job = JSON.parse(duplicate.data) as Job;
        this.db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(actor, requestKey, fingerprint, job.id);
        return job;
      }
      const recent = this.list().filter((job) => job.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10));
      if (recent.length >= 50 || (input.mode === "bedrock" && recent.filter((job) => job.mode === "bedrock").length >= 10)) throw new Error("Daily job limit reached");
      const now = new Date().toISOString();
      const job: Job = { ...input, id: randomUUID(), runId: randomUUID(), state: "queued", attempts: 0,
        createdAt: now, updatedAt: now, error: null };
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?)").run(job.id, actor, requestKey, fingerprint, job.state, JSON.stringify(job));
      this.db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(actor, requestKey, fingerprint, job.id);
      this.appendAudit("job_queued", actor, input.caseId, job.id);
      return job;
    });
  }
  list(allowedCases?: ReadonlySet<string>): Job[] {
    return (this.db.prepare("SELECT data FROM jobs ORDER BY rowid DESC").all() as { data: string }[])
      .map((row) => JSON.parse(row.data) as Job).filter((job) => !allowedCases || allowedCases.has(job.caseId));
  }
  claim(): Job | null {
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM jobs WHERE state='running'").get()) return null;
      const row = this.db.prepare("SELECT data FROM jobs WHERE state='queued' ORDER BY rowid LIMIT 1").get() as Row | undefined;
      if (!row) return null;
      const job = JSON.parse(row.data) as Job;
      job.state = "running"; job.attempts++; job.updatedAt = new Date().toISOString();
      this.write(job); this.appendAudit("job_started", "worker", job.caseId, job.id); return job;
    });
  }
  finish(id: string, state: "succeeded" | "failed" | "cancelled", error: string | null = null): Job {
    return this.transaction(() => {
      const job = this.get(id);
      if (!["running", "queued"].includes(job.state)) return job;
      job.state = state; job.error = error; job.updatedAt = new Date().toISOString(); this.write(job);
      this.appendAudit(`job_${state}`, "worker", job.caseId, id); return job;
    });
  }
  get(id: string): Job {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("Job not found");
    return JSON.parse(row.data) as Job;
  }
  recover() { for (const job of this.list().filter((job) => job.state === "running")) this.finish(job.id, "failed", "interrupted"); }
  private write(job: Job) { this.db.prepare("UPDATE jobs SET state=?,data=? WHERE id=?").run(job.state, JSON.stringify(job), job.id); }
  audit(event: string, actor = "demo", caseId: string | null = null, reference: string | null = null) {
    this.transaction(() => this.appendAudit(event, actor, caseId, reference));
  }
  private appendAudit(event: string, actor: string, caseId: string | null, reference: string | null) {
    const previous = this.db.prepare("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined;
    const data = JSON.stringify({ event, actor, caseId, reference, at: new Date().toISOString() });
    const previousHash = previous?.hash ?? "";
    this.db.prepare("INSERT INTO audit(data,previous_hash,hash) VALUES(?,?,?)").run(data, previousHash, sha256(previousHash + data));
  }
  verifyAudit(): boolean {
    let previous = "";
    for (const row of this.db.prepare("SELECT data,previous_hash,hash FROM audit ORDER BY id").all() as { data: string; previous_hash: string; hash: string }[]) {
      if (row.previous_hash !== previous || row.hash !== sha256(previous + row.data)) return false;
      previous = row.hash;
    }
    return true;
  }
  close() { this.db.close(); }
}
