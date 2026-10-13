import { readFile } from "node:fs/promises";
import { z } from "zod";

export type ReviewerIdentity = { issuer: string; subject: string; name: string };
const assignmentSchema = z.strictObject({
  issuer: z.url(), subject: z.string().min(1), role: z.enum(["viewer", "reviewer"]),
  caseIds: z.array(z.string().regex(/^CASE-\d{3}$/)),
});
const policySchema = z.strictObject({ assignments: z.array(assignmentSchema) });
export type AccessAssignment = z.infer<typeof assignmentSchema>;

export function parseAccessPolicy(value: unknown) {
  const policy = policySchema.parse(value);
  const keys = policy.assignments.map((assignment) => JSON.stringify([assignment.issuer, assignment.subject]));
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate access assignment");
  return policy;
}

export async function accessFor(path: string, identity: ReviewerIdentity): Promise<AccessAssignment | null> {
  const policy = parseAccessPolicy(JSON.parse(await readFile(path, "utf8")));
  return policy.assignments.find((assignment) => assignment.issuer === identity.issuer && assignment.subject === identity.subject) ?? null;
}
