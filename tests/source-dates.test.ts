import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseSource } from "../src/contracts.ts";
import { newestSourceId, sourceDate } from "../web/source-dates.ts";

function source(id: string, content: string, kind: CaseSource["kind"] = "document"): CaseSource {
  return { sourceId: id, path: id, kind, content, sha256: "unused" };
}
const citations = [{ sourceId: "old", quote: "old" }, { sourceId: "new", quote: "new" }];

test("source dates use Created or Sent metadata and display UTC", () => {
  const date = sourceDate(source("email", "Sent: 2026-10-05T05:00:00-06:00", "correspondence"));
  assert.equal(date?.label, "Sent");
  assert.match(date!.display, /11:00:00 UTC/);
  assert.equal(sourceDate(source("doc", "Date of birth: 1982-04-09\nCollection date: 2026-10-04")), null);
});

test("invalid, absent, and ambiguous dates are unavailable", () => {
  for (const content of ["", "Created: yesterday", "Created: 2026-02-30T08:00:00Z",
    "Created: 2026-10-05T08:00:00", "Created: 2026-10-05T08:00:00Z\nCreated: 2026-10-05T09:00:00Z"]) {
    assert.equal(sourceDate(source("doc", content)), null);
  }
});

test("chronology compares timestamps independently of citation order", () => {
  const sources = [source("old", "Created: 2026-10-05T08:00:00Z"),
    source("new", "Sent: 2026-10-05T11:00:00Z", "correspondence")];
  assert.equal(newestSourceId(citations, sources), "new");
  assert.equal(newestSourceId([...citations].reverse(), sources), "new");
});

test("ties, missing sources, and incomplete dates do not highlight a winner", () => {
  const old = source("old", "Created: 2026-10-05T08:00:00Z");
  assert.equal(newestSourceId(citations, [old, source("new", old.content)]), null);
  assert.equal(newestSourceId(citations, [old]), null);
  assert.equal(newestSourceId(citations, [old, source("new", "")]), null);
  assert.equal(newestSourceId([citations[0], citations[0]], [old]), null);
});
