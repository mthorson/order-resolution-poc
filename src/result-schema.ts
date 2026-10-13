import { z } from "zod";
import type { AnalysisResult } from "./contracts.ts";
import { proposalSchema } from "./validate-proposal.ts";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const common = {
  schemaVersion: z.literal("case-analysis.v1"),
  run: z.strictObject({
    runId: text, caseId: text, snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    rulesVersion: text, promptVersion: text, validatorVersion: text, provider: text, model: text,
    startedAt: z.iso.datetime(), durationMs: count, modelCalls: count,
    usage: z.strictObject({ inputTokens: count, outputTokens: count }).nullable(),
    estimatedCostUsd: z.number().nonnegative().nullable(), costBasis: text.nullable(),
  }),
  requiresHumanApproval: z.literal(true), actionState: z.literal("not_executed"),
};

export const resultSchema = z.discriminatedUnion("outcome", [
  proposalSchema.omit({ schemaVersion: true }).extend({ ...common,
    outcome: z.literal("analyzed"), status: z.enum(["ready_for_review", "needs_information", "needs_clarification"]),
  }),
  z.strictObject({ ...common, outcome: z.literal("analysis_failed"),
    error: z.strictObject({
      code: z.enum(["invalid_input", "input_limit", "provider_error", "budget_exhausted", "invalid_output", "invalid_evidence"]),
      message: text, sourceIds: z.array(text),
    }),
  }),
]) satisfies z.ZodType<AnalysisResult>;
