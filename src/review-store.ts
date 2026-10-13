import type { ReviewerIdentity } from "./access-policy.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { sha256, validateBundle } from "./bundle-integrity.ts";
import { withCaseLock } from "./case-lock.ts";
import { loadCase } from "./load-case.ts";
import { resultSchema } from "./result-schema.ts";
import { renderReview } from "./review.ts";
import type { ReviewDetail, ReviewInput, ReviewRecord, ReviewSummary } from "./review-types.ts";

const reportSchema = z.object({ cases: z.array(z.object({
  patientFolder: z.string().regex(/^patient-\d{3}$/),
  analysis: z.object({ resultPath: z.string() }),
})), caseRoot: z.enum(["fixtures/patients", "evals/heldout/patients", "evals/final/patients"]).optional() });
const reviewInputSchema = z.strictObject({
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/), resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedReviewId: z.uuid().nullable(), reviewer: z.string().trim().min(1).max(100),
  decision: z.enum(["accepted", "changes_requested", "rejected"]), notes: z.string().trim().max(4000),
  draftBody: z.string().trim().min(1).max(16000).nullable(), evidenceChecked: z.literal(true),
  reviewDurationMs: z.number().int().nonnegative().max(3_600_000).optional(),
}).refine((value) => value.decision === "accepted" || value.notes.length > 0,
  "Changes or rejection need a note");

export class ReviewStoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class ReviewStore {
  readonly root: string;
  readonly caseRoot: "fixtures/patients" | "evals/heldout/patients" | "evals/final/patients";
  private readonly registryPath: string;
  private readonly entries: Map<string, { resultPath: string; patientFolder: string; caseId: string }>;
  private constructor(root: string, entries: Map<string, { resultPath: string; patientFolder: string; caseId: string }>, registryPath: string, caseRoot: "fixtures/patients" | "evals/heldout/patients" | "evals/final/patients") {
    this.root = root; this.entries = entries; this.registryPath = registryPath; this.caseRoot = caseRoot;
  }

  static async open(root: string, reportPath: string): Promise<ReviewStore> {
    const runs = await realpath(join(root, "runs"));
    const reportText = await readFile(reportPath, "utf8");
    const report = reportSchema.parse(JSON.parse(reportText));
    const registryPath = join(runs, "registries", `${sha256(reportText)}.json`);
    const entries = new Map<string, { resultPath: string; patientFolder: string; caseId: string }>();
    for (const item of report.cases) {
      const saved = /(?:^|\/)runs\/([a-f0-9-]{36})\/result\.json$/.exec(item.analysis.resultPath);
      if (!saved) throw new Error("Result path must be inside a run folder");
      const path = await realpath(join(runs, saved[1], "result.json"));
      if (dirname(dirname(path)) !== runs || dirname(path) === runs) throw new Error("Result path must be inside a run folder");
      const result = resultSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (entries.has(result.run.runId)) throw new Error("Duplicate report run");
      entries.set(result.run.runId, { resultPath: path, patientFolder: item.patientFolder, caseId: result.run.caseId });
    }
    const store = new ReviewStore(root, entries, registryPath, report.caseRoot ?? "fixtures/patients");
    try {
      const registry = z.array(z.strictObject({ runId: z.uuid(), patientFolder: z.string().regex(/^patient-\d{3}$/) })).parse(JSON.parse(await readFile(registryPath, "utf8")));
      for (const entry of registry) await store.register(entry.runId, entry.patientFolder, false);
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    return store;
  }

  async register(runId: string, patientFolder: string, persist = true) {
    if (!/^[a-f0-9-]{36}$/.test(runId) || !/^patient-\d{3}$/.test(patientFolder)) throw new Error("Invalid run registration");
    const resultPath = await realpath(join(this.root, "runs", runId, "result.json"));
    if (dirname(dirname(resultPath)) !== await realpath(join(this.root, "runs"))) throw new Error("Run escaped storage");
    const result = resultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
    if (result.run.runId !== runId) throw new Error("Run identity mismatch");
    this.entries.set(runId, { resultPath, patientFolder, caseId: result.run.caseId });
    await this.detail(runId);
    if (persist) {
      await mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.entries].map(([runId, entry]) => ({ runId, patientFolder: entry.patientFolder }))), { mode: 0o600 });
      await rename(temporary, this.registryPath);
    }
  }

  private entry(runId: string) {
    const entry = this.entries.get(runId);
    if (!entry) throw new ReviewStoreError(404, "Case not found in this review queue");
    return entry;
  }

  private async latestReview(runId: string): Promise<ReviewRecord | null> {
    const folder = join(dirname(this.entry(runId).resultPath), "reviews");
    let names: string[];
    try { names = await readdir(folder); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const records: ReviewRecord[] = [];
    for (const name of names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const raw: unknown = JSON.parse(await readFile(join(folder, name), "utf8"));
      const schema = z.strictObject({
        reviewId: z.uuid(), createdAt: z.iso.datetime(), runId: z.string(), snapshotId: z.string(), resultSha256: z.string(),
        reviewer: z.string(), reviewerIdentity: z.strictObject({ issuer: z.string(), subject: z.string() }).optional(), decision: z.enum(["accepted", "changes_requested", "rejected"]), notes: z.string(),
        draftBody: z.string().nullable(), evidenceChecked: z.literal(true), previousReviewId: z.uuid().nullable(),
        reviewDurationMs: z.number().int().nonnegative().optional(),
      });
      const record = schema.parse(raw);
      if (record.runId !== runId) throw new Error("Review belongs to another run");
      records.push(record);
    }
    const referenced = new Set(records.map((r) => r.previousReviewId));
    const heads = records.filter((r) => !referenced.has(r.reviewId));
    if (heads.length > 1 || (records.length && heads.length !== 1)) throw new Error("Review history is inconsistent");
    return heads[0] ?? null;
  }

  async detail(runId: string): Promise<ReviewDetail> {
    const path = this.entry(runId).resultPath;
    const text = await readFile(path, "utf8");
    const result = resultSchema.parse(JSON.parse(text));
    const input = await realpath(join(dirname(path), "input.json"));
    if (dirname(input) !== dirname(path)) throw new Error("Input path escapes run folder");
    const bundle = validateBundle(JSON.parse(await readFile(input, "utf8")));
    renderReview(result, bundle); // Recheck references and snapshot before serving it.
    const resultSha256 = sha256(text);
    const review = await this.latestReview(runId);
    if (review && (review.resultSha256 !== resultSha256 || review.snapshotId !== bundle.snapshotId)) {
      throw new Error("Saved review does not match this result");
    }
    let sourceState: ReviewDetail["sourceState"] = "unavailable";
    try { sourceState = (await loadCase(join(this.root, this.caseRoot, this.entry(runId).patientFolder))).snapshotId === bundle.snapshotId ? "current" : "changed"; }
    catch { /* Existing evidence stays inspectable, but approval is blocked. */ }
    return { result, bundle, resultSha256, review, sourceState };
  }

  caseId(runId: string): string { return this.entry(runId).caseId; }
  patientFolder(runId: string): string { return this.entry(runId).patientFolder; }

  async list(allowedCases?: ReadonlySet<string>): Promise<ReviewSummary[]> {
    const summaries: ReviewSummary[] = [];
    const latest = new Map<string, string>();
    for (const [runId, entry] of this.entries) latest.set(entry.caseId, runId);
    for (const [runId, entry] of this.entries) {
      if (latest.get(entry.caseId) !== runId) continue;
      if (allowedCases && !allowedCases.has(entry.caseId)) continue;
      const detail = await this.detail(runId);
      const result = detail.result;
      summaries.push({ runId, caseId: result.run.caseId, patientFolder: entry.patientFolder,
        patientName: result.outcome === "analyzed" ? result.facts.find((f) => f.field === "patient_name")?.value ?? entry.patientFolder : entry.patientFolder,
        status: result.outcome === "analyzed" ? result.status : "analysis_failed",
        issueCount: result.outcome === "analyzed" ? result.issues.length : 0,
        reviewDecision: detail.review?.decision ?? null, stale: detail.sourceState !== "current" });
    }
    return summaries;
  }

  async save(runId: string, value: unknown, identity?: ReviewerIdentity): Promise<ReviewRecord> {
    const submitted = identity && typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...value, reviewer: identity.name } : value;
    const parsed = reviewInputSchema.safeParse(submitted);
    if (!parsed.success) throw new ReviewStoreError(400, "Enter a reviewer, confirm evidence review, and add notes for changes or rejection");
    const input: ReviewInput = parsed.data;
    const runDir = dirname(this.entry(runId).resultPath);
    return withCaseLock(join(runDir, ".review-write.lock"), async () => {
      const detail = await this.detail(runId);
      const current = await loadCase(join(this.root, this.caseRoot, this.entry(runId).patientFolder));
      if (input.snapshotId !== detail.bundle.snapshotId || input.resultSha256 !== detail.resultSha256 ||
        current.snapshotId !== input.snapshotId || input.expectedReviewId !== (detail.review?.reviewId ?? null)) {
        throw new ReviewStoreError(409, "The case or review changed. Reload it before recording a decision");
      }
      if (detail.result.outcome !== "analyzed") throw new ReviewStoreError(400, "A failed analysis cannot be accepted as a reviewed result");
      if ((detail.result.followUpDraft === null) !== (input.draftBody === null)) throw new ReviewStoreError(400, "Draft presence must match this analysis");
      const record: ReviewRecord = { reviewId: randomUUID(), createdAt: new Date().toISOString(),
        runId, snapshotId: input.snapshotId, resultSha256: input.resultSha256, reviewer: input.reviewer,
        decision: input.decision, notes: input.notes, draftBody: input.draftBody,
        evidenceChecked: true, previousReviewId: input.expectedReviewId,
        ...(identity ? { reviewerIdentity: { issuer: identity.issuer, subject: identity.subject } } : {}) };
      if (input.reviewDurationMs !== undefined) record.reviewDurationMs = input.reviewDurationMs;
      const folder = join(runDir, "reviews");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, `${record.reviewId}.json`), JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      return record;
    });
  }
}
