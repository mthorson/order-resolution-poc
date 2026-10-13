import { useEffect, useRef, useState } from "react";
import type { CaseSource, Citation, Issue } from "../src/contracts.ts";
import type { ReviewDetail, ReviewInput, ReviewRecord, ReviewSummary } from "../src/review-types.ts";
import { newestSourceId, sourceDate } from "./source-dates.ts";
import { Operations, type OperationsData } from "./Operations.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { evidenceGroups, type EvidenceGroup } from "./evidence.ts";

const labels = { ready_for_review: "Ready for review", needs_information: "Missing information",
  needs_clarification: "Conflicting information", analysis_failed: "Analysis failed" };
const decisions = { accepted: "Accepted", changes_requested: "Changes requested", rejected: "Rejected" };
const fieldName = (value: string) => value.replaceAll("_", " ").replace(/\bid\b/g, "ID").replace(/^./, (c) => c.toUpperCase());

async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options,
    headers: { "Content-Type": "application/json", "X-Review-Token": token, ...options.headers } });
  const body = await response.json();
  if (response.status === 401) window.location.assign("/");
  if (!response.ok) throw new Error(body.error ?? "Could not complete the request");
  return body;
}

function SourceButton({ citation, onSelect }: { citation: Citation; onSelect: (c: Citation) => void }) {
  return <button className="source-link" onClick={() => onSelect(citation)}>
    <span aria-hidden="true">↗</span> View evidence
  </button>;
}

function IssueCard({ issue, sources, selected, onInspect, onSelect }: { issue: Issue; sources: CaseSource[]; selected: boolean; onInspect: () => void; onSelect: (c: Citation) => void }) {
  const panel = issue.field === "requested_panel";
  const newest = issue.kind === "conflicting" ? newestSourceId(issue.candidates.flatMap((candidate) => candidate.evidence), sources) : null;
  return <article className={`issue-card ${issue.kind} ${selected ? "selected-item" : ""}`}>
    <div className="issue-heading"><h3><button className="inspect-item" aria-pressed={selected} onClick={onInspect}>{fieldName(issue.field)}</button></h3><span className={`pill ${issue.kind}`}>{issue.kind === "conflicting" ? "Conflict" : "Missing"}</span></div>
    {issue.kind === "conflicting" ? <div className="candidate-grid">{issue.candidates.map((candidate, index) =>
      <div className={`candidate ${candidate.evidence.some((citation) => citation.sourceId === newest) ? "newer-source" : ""}`} key={`${candidate.value}-${index}`}>
        <span className="eyebrow">Source {index + 1}</span><strong>{candidate.value}</strong>
        {candidate.evidence.filter((citation, i, evidence) => evidence.findIndex((other) => other.sourceId === citation.sourceId) === i).map((citation) => {
          const source = sources.find((source) => source.sourceId === citation.sourceId);
          const date = source ? sourceDate(source) : null;
          return <div className="candidate-source" key={citation.sourceId}>
            <span className="source-name">{citation.sourceId.split("/").at(-1)?.replace(/\.txt$/, "").replaceAll("-", " ")}</span>
            <span className="source-date">{date ? <>{date.label} · <time dateTime={date.iso}>{date.display}</time></> : "Source date unavailable"}</span>
            {citation.sourceId === newest && <span className="newer-badge">Newer source</span>}
            <SourceButton citation={citation} onSelect={onSelect} />
          </div>;
        })}
      </div>)}</div> : <p className="missing-description">Not supplied in the reviewed case documents.</p>}
    <div className="rule-note"><span className="rule-icon" aria-hidden="true">i</span><p>
      {panel ? issue.kind === "conflicting" ? "A later email doesn't replace a signed order. Request a corrected signed requisition." : "Ask the provider to identify the panel on a signed requisition."
        : issue.field === "date_of_birth" ? "Reconcile against an authoritative patient record. Don't choose a date by recency or majority."
          : issue.field === "provider_signature" ? "A promise to sign later doesn't resolve this. Request a signed requisition."
            : "Request the missing information; don't infer it from another date or record."}
    </p></div>
  </article>;
}

export function App() {
  const [token, setToken] = useState("");
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signedInReviewer, setSignedInReviewer] = useState<string | null>(null);
  const [role, setRole] = useState("reviewer");
  const [cases, setCases] = useState<ReviewSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [selection, setSelection] = useState<Citation | null>(null);
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [tab, setTab] = useState("issues");
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [notes, setNotes] = useState("");
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [operations, setOperations] = useState<OperationsData | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const openedAt = useRef(Date.now());
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function boot() {
      try {
        const session = await api<{ token: string; authenticated: boolean; authentication: string; reviewer?: string; role?: string }>("/api/session", "", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!session.authenticated) { setNeedsSignIn(true); return; }
        if (session.authentication === "oidc") { setSignedInReviewer(session.reviewer!); setReviewer(session.reviewer!); }
        setRole(session.role ?? "reviewer");
        const list = await api<{ cases: ReviewSummary[] }>("/api/cases", session.token, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setToken(session.token); setCases(list.cases);
        setSelected((list.cases.find((c) => c.status === "needs_clarification") ?? list.cases[0])?.runId ?? "");
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load cases"); }
    }
    void boot();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selected || !token) return;
    const controller = new AbortController();
    openedAt.current = Date.now();
    setDetail(null); setActiveItem(null); setSelection(null); setDraft(""); setNotes(""); setChecked(false); setError(""); setNotice("");
    async function load() {
      try {
        const value = await api<ReviewDetail>(`/api/cases/${selected}`, token, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetail(value);
        if (value.result.outcome === "analyzed") {
          setDraft(value.review?.draftBody ?? value.result.followUpDraft?.body ?? "");
          setTab(value.result.issues.length ? "issues" : "facts");
          const firstGroup = evidenceGroups(value.result, value.result.issues.length ? "issues" : "facts")[0];
          setActiveItem(firstGroup?.id ?? null);
          const issue = value.result.issues[0];
          setSelection(issue?.kind === "conflicting" ? issue.candidates[0].evidence[0]
            : !issue ? value.result.facts[0]?.evidence[0] ?? null : null);
        }
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load case"); }
    }
    void load();
    return () => controller.abort();
  }, [selected, token, refresh]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api<OperationsData>("/api/operations", token, { signal: controller.signal });
        if (!controller.signal.aborted) setOperations(data);
      } catch { /* Case requests show errors; background metrics must not discard edits. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 2000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [token]);

  const result = detail?.result.outcome === "analyzed" ? detail.result : null;
  const current = cases.find((c) => c.runId === selected);
  const originalDraft = detail?.review?.draftBody ?? result?.followUpDraft?.body ?? "";
  const dirty = draft !== originalDraft || Boolean(notes);
  const groups = result ? [
    ...evidenceGroups(result, "issues"), ...evidenceGroups(result, "facts"), ...evidenceGroups(result, "corrections"),
    ...result.warnings.map((warning, i): EvidenceGroup => ({ id: `warning:${i}`, title: fieldName(warning.kind), citations: warning.evidence, examinedSourceIds: [] })),
  ] : [];
  const activeGroup = groups.find((group) => group.id === activeItem);
  const selectItem = (id: string) => {
    setActiveItem(id); setSelection(null);
  };
  const chooseTab = (nextTab: string) => {
    setTab(nextTab); setActiveItem(result ? evidenceGroups(result, nextTab)[0]?.id ?? null : null); setSelection(null);
  };
  const selectEvidence = (citation: Citation, id: string) => {
    setActiveItem(id); setSelection(citation);
    requestAnimationFrame(() => {
      document.querySelector(".evidence-hit.is-selected")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };
  const chooseCase = (id: string) => {
    if (dirty && !window.confirm("Discard the unsaved draft edits and notes?")) return;
    setDetail(null); setSelected(id);
  };
  const reloadCase = () => {
    if (dirty && !window.confirm("Discard the unsaved draft edits and notes?")) return;
    setRefresh((value) => value + 1);
  };
  async function save(decision: ReviewRecord["decision"]) {
    if (!detail || !result) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const body: ReviewInput = { snapshotId: detail.bundle.snapshotId, resultSha256: detail.resultSha256,
        expectedReviewId: detail.review?.reviewId ?? null, reviewer, decision, notes,
        reviewDurationMs: Math.min(3_600_000, Date.now() - openedAt.current),
        draftBody: result.followUpDraft ? draft : null, evidenceChecked: true };
      const record = await api<ReviewRecord>(`/api/cases/${selected}/reviews`, token, { method: "POST", body: JSON.stringify(body) });
      setDetail({ ...detail, review: record }); setNotes(""); setChecked(false);
      setCases((list) => list.map((item) => item.runId === selected ? { ...item, reviewDecision: record.decision } : item));
      setNotice(`${decisions[record.decision]} · review saved. No message was sent.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save review"); }
    finally { setSaving(false); }
  }
  async function enqueueAnalysis() {
    if (!selected || enqueuing) return;
    if (dirty && !window.confirm("Start a new analysis before saving these edits?")) return;
    setEnqueuing(true); setError("");
    try {
      await api(`/api/cases/${selected}/reanalyze`, token, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" });
      setNotice("Analysis queued. Only one case is processed at a time.");
      setOperations(await api<OperationsData>("/api/operations", token));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not queue analysis"); }
    finally { setEnqueuing(false); }
  }
  async function openAnalysis(runId: string) {
    try {
      const list = await api<{ cases: ReviewSummary[] }>("/api/cases", token);
      if (!list.cases.some((item) => item.runId === runId)) { setError("This job has no saved analysis to open."); return; }
      setCases(list.cases); chooseCase(runId);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not open analysis"); }
  }
  async function cancelJob(id: string) {
    try { await api(`/api/jobs/${id}/cancel`, token, { method: "POST", body: "{}" }); setOperations(await api<OperationsData>("/api/operations", token)); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not cancel job"); }
  }
  const reviewCount = cases.filter((c) => c.reviewDecision !== null).length;
  const busyCase = operations?.jobs.some((job) => job.caseId === current?.caseId && ["queued", "running"].includes(job.state));
  const visible = cases.filter((c) => filter === "all" || c.status !== "ready_for_review");
  const canDecide = Boolean(role === "reviewer" && detail?.sourceState === "current" && reviewer.trim() && checked && !saving && result && (!result.followUpDraft || draft.trim()));

  if (needsSignIn) return <main className="sign-in-page"><section className="decision-card"><h1>Order review</h1><p>Sign in to see your assigned cases.</p><a className="primary-button" href="/auth/login">Sign in</a></section></main>;

  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/" aria-label="Order review home"><span className="brand-mark">o<span /></span><div>Order review<small>CASE WORKSPACE</small></div></a>
      <div className="queue-heading"><span className="eyebrow">REVIEW QUEUE</span><span className="queue-count">{cases.length}</span></div>
      <div className="queue-filters" aria-label="Queue filter"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All cases</button><button className={filter === "attention" ? "active" : ""} onClick={() => setFilter("attention")}>Needs attention</button></div>
      <nav className="case-list" aria-label="Patient cases">{visible.map((item) => <button className={`case-item ${selected === item.runId ? "selected" : ""}`} key={item.runId}
        disabled={saving} onClick={() => chooseCase(item.runId)} aria-current={selected === item.runId ? "page" : undefined} aria-label={`${item.caseId} ${item.patientName}`}>
        <div className="case-number">{item.patientFolder.slice(-3)}<span className={`status-dot ${item.status}`} /></div><div className="case-item-copy"><strong>{item.patientName}</strong><span>{item.caseId}</span><small>{item.reviewDecision ? decisions[item.reviewDecision] : labels[item.status]}</small></div><span className="case-arrow" aria-hidden="true">›</span>
      </button>)}</nav>
      <div className="sidebar-footer"><span className="local-dot" /> {signedInReviewer ? "Signed in" : "Local demo"} <span className="synthetic-label">Synthetic data</span><p>No clinical decisions or messages are executed here.</p></div>
    </aside>

    <main className="workspace"><header className="topbar"><div className="breadcrumb">Workspace <span>/</span> Case review</div><div className="review-progress"><span>{reviewCount}</span> of {cases.length} reviewed<span className="avatar">R</span>{signedInReviewer && <button className="quiet-button" onClick={() => { void api("/api/logout", token, { method: "POST" }).then(() => window.location.reload()).catch((err: Error) => setError(err.message)); }}>Sign out</button>}</div></header>
      <div className="workspace-content"><div className="page-heading"><div><span className="eyebrow">ONE CASE. ALL THE EVIDENCE.</span><h1>Review the evidence.</h1><p>Spot the gaps, check the source, decide what happens next.</p></div><button className="quiet-button" disabled={saving || !selected} onClick={reloadCase}>↻ Reload case</button></div>
        {error && <div className="message error" role="alert">{error}</div>}
        <Operations data={operations} caseId={current?.caseId} reviewer={role === "reviewer"} onCancel={(id) => { void cancelJob(id); }} onOpen={(runId) => { void openAnalysis(runId); }} />
        {notice && <div className="message success" role="status">{notice}</div>}
        {!selected && !error && <div className="loading-state" role="status">Opening your review queue…</div>}
        {selected && !detail && !error && <div className="loading-state" role="status">Loading this case’s evidence…</div>}
        {detail && detail.sourceState !== "current" && <div className="message error">The source documents changed or are unavailable. Check them and reanalyze before recording a review.</div>}
        {detail && <div className="analysis-controls"><button className="quiet-button" disabled={role !== "reviewer" || enqueuing || busyCase} onClick={() => { void enqueueAnalysis(); }}>{enqueuing || busyCase ? "Analysis pending…" : "Reanalyze case"}</button><span className="muted small">{operations?.mode === "bedrock" ? "Uses the configured AI model" : "Local demonstration replay"}</span></div>}
        {detail?.result.outcome === "analysis_failed" && <div className="message error">This analysis failed: {detail.result.error.message}. Run a new analysis before review.</div>}
        {detail && result && <>
          <div className="case-banner"><div className="patient-avatar">{current?.patientName.split(" ").map((word) => word[0]).slice(0, 2).join("")}</div><div><span className="eyebrow">{result.run.caseId}</span><h2>{current?.patientName}</h2><p>{result.issues.length ? `${result.issues.length} unresolved ${result.issues.length === 1 ? "item" : "items"} · source-backed analysis` : "Required information is complete · ready for your review"}</p></div><span className={`pill ${result.status}`}>{labels[result.status]}</span></div>
          <div className="review-grid"><section className="findings-column" aria-label="Case findings">
            <div className="tabs" role="tablist" aria-label="Case information"><button role="tab" aria-selected={tab === "issues"} className={tab === "issues" ? "active" : ""} onClick={() => chooseTab("issues")}>Issues <span>{result.issues.length}</span></button><button role="tab" aria-selected={tab === "facts"} className={tab === "facts" ? "active" : ""} onClick={() => chooseTab("facts")}>Extracted fields <span>{result.facts.length}</span></button><button role="tab" aria-selected={tab === "corrections"} className={tab === "corrections" ? "active" : ""} onClick={() => chooseTab("corrections")}>Corrections <span>{result.corrections.length}</span></button></div>
            <div className="tab-content" role="tabpanel">
              {tab === "issues" && (result.issues.length ? result.issues.map((issue) => <IssueCard key={issue.field} issue={issue} sources={detail.bundle.sources} selected={activeItem === `issues:${issue.field}`} onInspect={() => selectItem(`issues:${issue.field}`)} onSelect={(citation) => selectEvidence(citation, `issues:${issue.field}`)} />) : <div className="empty-card"><span>✓</span><h3>No unresolved fields</h3><p>Check the evidence, then record your review. This doesn't authorize testing.</p></div>)}
              {tab === "facts" && <div className="facts-table">{result.facts.map((fact) => <div className={`fact-row ${activeItem === `facts:${fact.field}` ? "selected-item" : ""}`} key={fact.field}><button className="inspect-item" aria-pressed={activeItem === `facts:${fact.field}`} onClick={() => selectItem(`facts:${fact.field}`)}>{fieldName(fact.field)}</button><strong>{fact.value}</strong><SourceButton citation={fact.evidence[0]} onSelect={(citation) => selectEvidence(citation, `facts:${fact.field}`)} /></div>)}</div>}
              {tab === "corrections" && (result.corrections.length ? result.corrections.map((correction) => <article className="correction-card" key={correction.field}><span className="pill ready_for_review">Resolved</span><h3>{fieldName(correction.field)}</h3><p>The signed correction replaces the original record for this field.</p><div className="correction-path">{correction.originalSourceId}<span>↓</span>{correction.replacementSourceId}</div>{correction.evidence.map((citation, i) => <SourceButton key={i} citation={citation} onSelect={(citation) => selectEvidence(citation, `corrections:${correction.field}`)} />)}</article>) : <div className="empty-card"><h3>No recorded corrections</h3><p>No signed replacement resolved an earlier issue in this analysis.</p></div>)}
            </div>
            {result.warnings.length > 0 && <details className="warning-list"><summary>{result.warnings.length} review {result.warnings.length === 1 ? "warning" : "warnings"}</summary>{result.warnings.map((warning, i) => <div key={i}><strong>{fieldName(warning.kind)}</strong><p>{warning.kind === "instruction_attempt" ? "The document contains instructions the assistant must ignore." : warning.kind === "unrelated_document" ? "This content refers to another case and must not supply patient facts." : "Identity evidence needs reconciliation."}</p>{warning.evidence.map((citation, j) => <SourceButton key={j} citation={citation} onSelect={(citation) => selectEvidence(citation, `warning:${i}`)} />)}</div>)}</details>}
            <section className="draft-card"><div className="section-heading"><div><span className="eyebrow">NEXT STEP</span><h2>Provider follow-up</h2></div><span className="draft-label">{result.followUpDraft ? "Draft · not sent" : "Not needed"}</span></div>
              {result.followUpDraft ? <><div className="draft-subject"><span>Subject</span><strong>{result.followUpDraft.subject}</strong></div><label className="sr-only" htmlFor="draft-body">Follow-up draft</label><textarea id="draft-body" value={draft} onChange={(event) => setDraft(event.target.value)} rows={10} /><p className="muted small">Edit freely. Your reviewed version is saved separately from the original.</p></> : <p className="no-draft">No missing information to request. Review the case without creating an unnecessary follow-up.</p>}
            </section>
            <section className="decision-card"><div className="section-heading"><div><span className="eyebrow">YOUR CALL</span><h2>Record your review</h2></div>{detail.review && <span className="pill reviewed">{decisions[detail.review.decision]}</span>}</div>
              <label className="field-label" htmlFor="reviewer">{signedInReviewer ? "Signed-in reviewer" : "Reviewer name"}</label>{role === "viewer" && <p className="muted small">You have view-only access. A reviewer must record the decision.</p>}<input id="reviewer" value={reviewer} readOnly={signedInReviewer !== null} onChange={(event) => setReviewer(event.target.value)} placeholder="Your name" maxLength={100} />
              <label className="field-label" htmlFor="review-notes">Notes <span className="muted">· required for changes or rejection</span></label><textarea id="review-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What needs changing, or why you're rejecting this result" rows={2} />
              <label className="checkbox-label"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />I checked the source evidence and follow-up draft.</label>
              <div className="decision-buttons"><button className="primary-button" disabled={!canDecide} onClick={() => void save("accepted")}>{saving ? "Saving…" : "Accept analysis"}<span aria-hidden="true">✓</span></button><button className="secondary-button" disabled={!canDecide || !notes.trim()} onClick={() => void save("changes_requested")}>Request changes</button><button className="reject-button" disabled={!canDecide || !notes.trim()} onClick={() => void save("rejected")}>Reject</button></div>
              <p className="muted small">Accepting records your review of this analysis. It doesn't authorize testing or send a message.</p>
              {detail.review && <p className="review-history">Last reviewed by {detail.review.reviewer} · {new Date(detail.review.createdAt).toLocaleString()}</p>}
            </section>
          </section><EvidencePanel key={`${selected}-${activeItem}`} sources={detail.bundle.sources} groups={activeGroup ? [activeGroup] : []} selection={selection} dispositions={new Map(result.sourceAssessments.map((a) => [a.sourceId, a.disposition]))} /></div>
        </>}
      </div>
    </main>
  </div>;
}
