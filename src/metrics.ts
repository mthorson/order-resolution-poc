import type { ReviewDetail } from "./review-types.ts";
import type { Job } from "./job-store.ts";

export function summarizeMetrics(details: ReviewDetail[], jobs: Job[]) {
  const runs = details.map((detail) => detail.result.run);
  const durations = runs.map((run) => run.durationMs).sort((a, b) => a - b);
  const reviewTimes = details.flatMap((detail) => detail.review?.reviewDurationMs === undefined ? [] : [detail.review.reviewDurationMs]);
  const versions = [...new Set(runs.map((run) => `${run.provider}/${run.model} · ${run.promptVersion} · ${run.rulesVersion}`))];
  return {
    cases: details.length, analyzed: details.filter((detail) => detail.result.outcome === "analyzed").length,
    failed: details.filter((detail) => detail.result.outcome === "analysis_failed").length,
    stale: details.filter((detail) => detail.sourceState !== "current").length,
    accepted: details.filter((detail) => detail.review?.decision === "accepted").length,
    pendingReview: details.filter((detail) => !detail.review).length,
    modelCalls: runs.reduce((sum, run) => sum + (run.provider === "local-playback" ? 0 : run.modelCalls), 0),
    inputTokens: runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, run) => sum + (run.usage?.outputTokens ?? 0), 0),
    estimatedCostUsd: runs.length && runs.every((run) => run.estimatedCostUsd !== null) ? runs.reduce((sum, run) => sum + run.estimatedCostUsd!, 0) : null,
    p95DurationMs: durations.length ? durations[Math.ceil(durations.length * .95) - 1] : null,
    medianReviewMs: reviewTimes.length ? [...reviewTimes].sort((a, b) => a - b)[Math.floor(reviewTimes.length / 2)] : null,
    jobs: { queued: jobs.filter((job) => job.state === "queued").length, running: jobs.filter((job) => job.state === "running").length,
      failed: jobs.filter((job) => job.state === "failed").length },
    alerts: [
      ...(jobs.some((job) => job.state === "running" && Date.now() - Date.parse(job.updatedAt) > 90_000) ? ["A job has exceeded its execution window"] : []),
      ...(jobs.filter((job) => job.state === "failed").length >= 3 ? ["Repeated job failures need attention"] : []),
      ...(jobs.filter((job) => job.mode === "bedrock" && job.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length >= 8 ? ["Approaching the daily live-job limit"] : []),
    ],
    versions, scope: "Latest visible case runs; review time includes idle time; cost requires a verified pricing basis",
  };
}
