import type { Job } from "../src/job-store.ts";
import type { summarizeMetrics } from "../src/metrics.ts";

export type OperationsData = { jobs: Job[]; metrics: ReturnType<typeof summarizeMetrics>; mode: Job["mode"] };
export function Operations({ data, caseId, reviewer, onCancel, onOpen }: {
  data: OperationsData | null; caseId: string | undefined; reviewer: boolean;
  onCancel: (id: string) => void; onOpen: (runId: string) => void;
}) {
  if (!data) return null;
  const metrics = data.metrics;
  const jobs = data.jobs.filter((job) => job.caseId === caseId).slice(0, 3);
  return <details className="operations-panel"><summary>Runs and metrics</summary>
    <div className="metric-grid">
      <div><strong>{metrics.accepted}/{metrics.cases}</strong><span>Reviewed and accepted</span></div>
      <div><strong>{metrics.p95DurationMs === null ? "—" : `${(metrics.p95DurationMs / 1000).toFixed(1)}s`}</strong><span>Analysis latency · p95</span></div>
      <div><strong>{metrics.inputTokens + metrics.outputTokens}</strong><span>Recorded model tokens</span></div>
      <div><strong>{metrics.estimatedCostUsd === null ? "Not priced" : `$${metrics.estimatedCostUsd.toFixed(4)}`}</strong><span>Estimated model cost</span></div>
    </div>
    <p className="muted small">{metrics.scope}</p>
    {metrics.alerts.map((alert) => <p className="message error" key={alert}>{alert}</p>)}
    {jobs.map((job) => <div className="job-row" key={job.id}><span>{job.state}{job.error ? ` · ${job.error.replaceAll("_", " ")}` : ""}</span>
      {reviewer && ["queued", "running"].includes(job.state) && <button className="quiet-button" onClick={() => onCancel(job.id)}>Cancel job</button>}
      {(job.state === "succeeded" || (job.state === "failed" && !["interrupted", "worker_failed", "snapshot_changed"].includes(job.error ?? ""))) && <button className="quiet-button" onClick={() => onOpen(job.runId)}>Open analysis</button>}
    </div>)}
    <details><summary>Run versions</summary>{metrics.versions.map((version) => <p className="muted small" key={version}>{version}</p>)}</details>
  </details>;
}
