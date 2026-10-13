import { createHash } from "node:crypto";
import { z } from "zod";
import type { CaseBundle, CaseSource } from "./contracts.ts";

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function snapshotId(patientId: string, caseId: string, sources: CaseSource[]): string {
  return sha256(JSON.stringify({ patientId, caseId,
    sources: [...sources].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map(({ path, sha256 }) => [path, sha256]),
  }));
}

const text = z.string().min(1).refine((value) => value.trim().length > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.strictObject({
  schemaVersion: z.literal("case-bundle.v1"), patientId: text, caseId: text,
  snapshotId: digest,
  sources: z.array(z.strictObject({
    sourceId: text, path: z.string().regex(/^(documents|correspondence)\/[A-Za-z0-9_-]+\.txt$/),
    kind: z.enum(["document", "correspondence"]), content: text, sha256: digest,
  })).min(1),
}) satisfies z.ZodType<CaseBundle>;

export function validateBundle(value: unknown): CaseBundle {
  const bundle = schema.parse(value);
  if (new Set(bundle.sources.map((s) => s.path)).size !== bundle.sources.length ||
      bundle.sources.some((s) => s.sourceId !== s.path || sha256(s.content) !== s.sha256 ||
        s.kind !== (s.path.startsWith("documents/") ? "document" : "correspondence")) ||
      bundle.snapshotId !== snapshotId(bundle.patientId, bundle.caseId, bundle.sources)) {
    throw new Error("Case bundle integrity check failed");
  }
  return bundle;
}
