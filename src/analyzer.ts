import type { AnalysisFailure, AnalysisResult, CaseBundle, RunMetadata } from "./contracts.ts";
import { validateBundle } from "./bundle-integrity.ts";
import { applyDecisionRules, rulesVersion } from "./decision-rules.ts";
import { instructions, promptVersion } from "./prompt.ts";
import { prepareModelCase } from "./quarantine.ts";
import { ProposalValidationError, validateProposal, proposalSchema } from "./validate-proposal.ts";

export type AnalysisLimits = {
  maxSources: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  maxModelCalls: number;
  timeoutMs: number;
};

export type ModelRequest = {
  instructions: string;
  caseBundle: CaseBundle; // Untrusted evidence, separate from instructions.
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type ModelResponse = {
  text: string; // Raw output; the analyzer parses and validates it.
  completion: "complete" | "truncated" | "refused";
  usage: { inputTokens: number; outputTokens: number } | null;
};

export type ModelAdapter = {
  provider: string;
  model: string;
  generate: (request: ModelRequest) => Promise<ModelResponse>;
};

export type AnalysisOptions = {
  runId: string;
  rulesVersion: "demo-order-completeness-v1";
  limits: AnalysisLimits;
  model: ModelAdapter;
};

export type AnalyzeCase = (
  bundle: CaseBundle,
  options: AnalysisOptions,
) => Promise<AnalysisResult>;

export const defaultAnalysisLimits: AnalysisLimits = {
  maxSources: 32, maxInputBytes: 256 * 1024, maxOutputTokens: 4096,
  maxModelCalls: 1, timeoutMs: 60000,
};

export class ModelInvocationError extends Error {
  constructor() { super("Model invocation failed; check credentials, model access, region, and provider configuration"); }
}

export const analyzeCase: AnalyzeCase = async (input, options) => {
  const started = Date.now();
  const run: RunMetadata = {
    runId: options.runId, caseId: input.caseId, snapshotId: input.snapshotId,
    rulesVersion: options.rulesVersion, promptVersion, validatorVersion: "proposal-and-demo-rules-v4",
    provider: options.model.provider, model: options.model.model, startedAt: new Date(started).toISOString(),
    durationMs: 0, modelCalls: 0, usage: null, estimatedCostUsd: null, costBasis: null,
  };
  function fail(code: AnalysisFailure["error"]["code"], message: string): AnalysisFailure {
    run.durationMs = Date.now() - started;
    return { schemaVersion: "case-analysis.v1", outcome: "analysis_failed", run,
      error: { code, message, sourceIds: [] }, requiresHumanApproval: true, actionState: "not_executed" };
  }
  if (options.rulesVersion !== rulesVersion || Object.values(options.limits).some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    return fail("invalid_input", "Unsupported rules or invalid execution limits");
  }
  let bundle: CaseBundle;
  try { bundle = validateBundle(input); }
  catch { return fail("invalid_input", "Case bundle failed runtime integrity checks"); }
  const prepared = prepareModelCase(bundle);
  if (!prepared.modelBundle.sources.length) return fail("invalid_input", "No sources passed case identity checks");
  const bytes = Buffer.byteLength(instructions) + Buffer.byteLength(JSON.stringify(prepared.modelBundle));
  if (bundle.sources.length > options.limits.maxSources || bytes > options.limits.maxInputBytes ||
      Buffer.byteLength(JSON.stringify(bundle)) > options.limits.maxInputBytes) {
    return fail("input_limit", "Case request exceeds configured input limits");
  }
  const controller = new AbortController();
  const remainingMs = options.limits.timeoutMs - (Date.now() - started);
  if (remainingMs <= 0) return fail("budget_exhausted", "Analysis timed out before model invocation");
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    run.modelCalls = 1;
    const response = await options.model.generate({ instructions, caseBundle: prepared.modelBundle,
      maxOutputTokens: options.limits.maxOutputTokens, signal: controller.signal });
    run.usage = response.usage;
    if (controller.signal.aborted) return fail("budget_exhausted", "Analysis timed out");
    if (response.completion !== "complete") return fail("invalid_output", "Model output was refused, truncated, or incomplete");
    let raw: unknown;
    try { raw = JSON.parse(response.text); }
    catch { return fail("invalid_output", "Model output is not a JSON object"); }
    // Context inventory is application metadata. Preserve the raw response, reject
    // unknown IDs, and derive the complete considered-source list from this request.
    const shape = proposalSchema.safeParse(raw);
    if (!shape.success) throw new ProposalValidationError("invalid_output", "Model proposal failed runtime schema checks");
    const includedIds = prepared.modelBundle.sources.map((source) => source.sourceId);
    const accounted = { ...shape.data, issues: shape.data.issues.map((issue) =>
      issue.kind === "missing" && issue.examinedSourceIds.every((id) => includedIds.includes(id))
        ? { ...issue, examinedSourceIds: includedIds } : issue) };
    const proposal = validateProposal(accounted, prepared.modelBundle);
    if (proposal.sourceAssessments.some((a) => a.disposition !== "included")) {
      return fail("invalid_evidence", "Model attempted to change prechecked source membership");
    }
    const merged = { ...proposal, sourceAssessments: prepared.assessments,
      warnings: [...proposal.warnings, ...prepared.warnings] };
    const decision = applyDecisionRules(merged, bundle);
    if (Date.now() - started >= options.limits.timeoutMs) return fail("budget_exhausted", "Analysis timed out");
    run.durationMs = Date.now() - started;
    return { schemaVersion: "case-analysis.v1", outcome: "analyzed", run, ...decision };
  } catch (error) {
    if (controller.signal.aborted) return fail("budget_exhausted", "Analysis timed out");
    if (error instanceof ProposalValidationError) return fail(error.code, error.message);
    if (error instanceof ModelInvocationError) return fail("provider_error", error.message);
    throw error;
  } finally { clearTimeout(timer); }
};
