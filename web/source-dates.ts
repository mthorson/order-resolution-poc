import { z } from "zod";
import type { CaseSource, Citation } from "../src/contracts.ts";

const timestamp = z.iso.datetime({ offset: true });
const displayDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function sourceDate(source: CaseSource) {
  const label = source.kind === "document" ? "Created" : "Sent";
  const matches = [...source.content.matchAll(new RegExp(`^${label}:\\s*([^\\r\\n]+)$`, "gm"))];
  if (matches.length !== 1) return null;
  const parsed = timestamp.safeParse(matches[0][1].trim());
  if (!parsed.success) return null;
  const milliseconds = Date.parse(parsed.data);
  return { label, iso: parsed.data, milliseconds, display: `${displayDate.format(milliseconds)} UTC` };
}

// Only mark chronology when every cited source has an unambiguous date.
export function newestSourceId(citations: Citation[], sources: CaseSource[]): string | null {
  const ids = [...new Set(citations.map((citation) => citation.sourceId))];
  if (ids.length < 2) return null;
  const dates = ids.map((id) => {
    const source = sources.find((source) => source.sourceId === id);
    return { id, date: source ? sourceDate(source) : null };
  });
  if (dates.some(({ date }) => date === null)) return null;
  const latest = Math.max(...dates.map(({ date }) => date!.milliseconds));
  const winners = dates.filter(({ date }) => date!.milliseconds === latest);
  return winners.length === 1 ? winners[0].id : null;
}
