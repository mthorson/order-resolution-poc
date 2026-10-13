import type { CaseSource, Citation } from "../src/contracts.ts";
import { evidenceExcerpt, type EvidenceGroup } from "./evidence.ts";
import { newestSourceId, sourceDate } from "./source-dates.ts";

function SourceDate({ source }: { source: CaseSource }) {
  const date = sourceDate(source);
  return <span className="source-date">{date ? <>{date.label} · <time dateTime={date.iso}>{date.display}</time></> : "Source date unavailable"}</span>;
}

export function EvidencePanel({ sources, groups, selection, dispositions }: {
  sources: CaseSource[]; groups: EvidenceGroup[]; selection: Citation | null; dispositions: Map<string, string>;
}) {
  const displayed = groups.map((group) => ({ ...group, citations: group.citations.filter((citation, i, citations) =>
    citations.findIndex((other) => other.sourceId === citation.sourceId && other.quote === citation.quote) === i) }));
  return <aside className="evidence-panel" aria-label="Source evidence">
    <div className="panel-heading"><div><span className="eyebrow">COMPARE THE SOURCES</span><h2>Source evidence</h2></div><span className="document-icon" aria-hidden="true">▤</span></div>
    <p className="evidence-intro">Evidence for the selected item. Highlighted text is the exact cited passage.</p>
    {displayed.map((group) => {
      const newest = newestSourceId(group.citations, sources);
      return <section className="evidence-group" key={group.id} aria-label={`${group.title} evidence`}>
        <h3>{group.title}</h3>
        {group.examinedSourceIds.length > 0 && <p className="evidence-intro">No passage cited for this missing field. Check the reviewed originals below.</p>}
        {group.examinedSourceIds.map((id) => {
          const source = sources.find((source) => source.sourceId === id);
          return source && <details className="examined-source" key={id}><summary>{source.path} · reviewed source</summary><SourceDate source={source} /><pre>{source.content}</pre></details>;
        })}
        {group.citations.map((citation) => {
          const source = sources.find((source) => source.sourceId === citation.sourceId);
          if (!source) return null;
          const excerpt = evidenceExcerpt(source.content, citation.quote);
          const active = selection?.sourceId === citation.sourceId && selection.quote === citation.quote;
          const excluded = dispositions.get(source.sourceId) !== "included";
          return <article className={`evidence-hit ${active ? "is-selected" : ""}`} key={`${citation.sourceId}-${citation.quote}`}>
            <div className="evidence-hit-heading"><h4>{source.path.split("/").at(-1)}</h4>{source.sourceId === newest && <span className="newer-badge">Newer source</span>}</div>
            <div className="source-meta"><span>{source.kind === "document" ? "Document" : "Correspondence"}</span><span>{excluded ? "Quarantined" : "Included in case"}</span></div>
            <SourceDate source={source} />
            {excluded && <div className="quarantine-note">Excluded from model context. Shown here for your review only.</div>}
            {excerpt ? <p className="evidence-excerpt">{excerpt.clippedStart && "…"}{excerpt.before}<mark>{excerpt.quote}</mark>{excerpt.after}{excerpt.clippedEnd && "…"}</p>
              : <p className="message error">Cited passage unavailable. Check the original.</p>}
            <details className="original-source"><summary>Open full source</summary><pre>{source.content}</pre></details>
          </article>;
        })}
      </section>;
    })}
    {!displayed.length && <p className="evidence-intro">Select an item to check its evidence.</p>}
    <details className="all-sources"><summary>All case sources · {sources.length}</summary>{sources.map((source) =>
      <details className="original-source" key={source.sourceId}><summary>{source.path}{dispositions.get(source.sourceId) !== "included" ? " · quarantined" : ""}</summary><SourceDate source={source} /><pre>{source.content}</pre></details>)}</details>
    <p className="evidence-caption">Dates show chronology; they don't decide which value is correct.</p>
  </aside>;
}
