import { expect, test } from "@playwright/test";

test("signed-out users see sign-in without loading the case queue", async ({ page }) => {
  let requestedCases = false;
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    authenticated: false, authentication: "oidc", loginUrl: "/auth/login",
  } }));
  await page.route("**/api/cases", (route) => { requestedCases = true; return route.continue(); });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/auth/login");
  await expect(page.getByRole("navigation", { name: "Patient cases" })).toHaveCount(0);
  expect(requestedCases).toBe(false);
});

test("signed-in viewers have a fixed identity and cannot save reviews", async ({ page }) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({ json: { ...session, authentication: "oidc", reviewer: "Verified viewer", role: "viewer" } });
  });
  await page.goto("/");
  const reviewer = page.getByLabel("Signed-in reviewer");
  await expect(reviewer).toHaveValue("Verified viewer");
  await expect(reviewer).toHaveAttribute("readonly", "");
  await page.getByLabel("I checked the source evidence and follow-up draft.").check();
  await expect(page.getByRole("button", { name: "Accept analysis" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("conflicts are visible beside highlighted source evidence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Drew Example", exact: true })).toBeVisible();
  const panel = page.locator(".issue-card").filter({ has: page.getByRole("heading", { name: "Requested panel", exact: true }) });
  await expect(panel.getByText("DEMO-A", { exact: true })).toBeVisible();
  await expect(panel.getByText("DEMO-B", { exact: true })).toBeVisible();
  const newer = panel.locator(".candidate.newer-source");
  await expect(newer).toHaveCount(1);
  await expect(newer.getByText("DEMO-B", { exact: true })).toBeVisible();
  await expect(newer.getByText("Newer source", { exact: true })).toBeVisible();
  await expect(newer.locator("time")).toHaveAttribute("datetime", "2026-10-06T16:42:00Z");
  await expect(newer.locator("time")).toContainText("16:42:00 UTC");
  await expect(panel.locator('time[datetime="2026-10-05T18:23:00Z"]')).toBeVisible();
  await expect(panel.getByText("A later email doesn't replace a signed order.", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Requested panel", exact: true }).click();
  const evidence = page.getByRole("region", { name: "Requested panel evidence", exact: true });
  await expect(evidence.locator(".evidence-hit")).toHaveCount(2);
  await expect(evidence.locator("mark")).toHaveText(["Requested panel: DEMO-A", "Please run DEMO-B."]);
  await expect(page.getByRole("region", { name: "Date of birth evidence", exact: true })).toHaveCount(0);
  await expect(page.locator("#source-select")).toHaveCount(0);
  await panel.getByRole("button", { name: "View evidence" }).nth(1).click();
  await expect(page.locator(".evidence-hit.is-selected mark")).toHaveText("Please run DEMO-B.");
  const email = evidence.locator(".evidence-hit").filter({ hasText: "01-provider-panel-message.txt" });
  await email.getByText("Open full source", { exact: true }).click();
  await expect(email.locator("pre")).toContainText("Attachments: none");
  await expect(page.getByLabel("Follow-up draft", { exact: true })).toHaveValue(/corrected signed requisition/);
  await page.screenshot({ path: "test-results/review-desktop.png", fullPage: true });
});

test("case switching ignores delayed results from the previous case", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Drew Example", exact: true })).toBeVisible();
  let release!: () => void;
  let started!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const requestFinished = new Promise<void>((resolve) => { finished = resolve; });
  await page.route(/\/api\/cases\/[a-f0-9-]{36}$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.bundle.caseId === "CASE-002") {
      started(); await gate;
      try { await route.fulfill({ response }); } catch { /* The old browser request was cancelled. */ }
      finished();
    } else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "CASE-002 Blair Example" }).click();
  await requestStarted;
  await page.getByRole("button", { name: "CASE-005 Emery Example" }).click();
  await expect(page.getByRole("heading", { name: "Emery Example", exact: true })).toBeVisible();
  release(); await requestFinished;
  await expect(page.getByLabel("Follow-up draft", { exact: true })).toHaveValue(/intended panel/);
  await expect(page.getByText("Provider signature", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Extracted fields" }).click();
  await expect(page.locator(".facts-table").getByText("Saliva", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Source evidence" })).not.toContainText("Blair Example");
  await expect(page.locator(".case-banner")).not.toContainText("Blair Example");
});

test("missing fields expose reviewed originals without invented evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "CASE-002 Blair Example" }).click();
  await page.getByRole("button", { name: "Collection date", exact: true }).click();
  const group = page.getByRole("region", { name: "Collection date evidence", exact: true });
  await expect(group).toContainText("No passage cited for this missing field");
  await expect(group.locator("mark")).toHaveCount(0);
  const requisition = group.locator(".examined-source").filter({ has: page.locator("summary", { hasText: "documents/01-requisition.txt" }) });
  await requisition.locator("summary").click();
  await expect(requisition.locator("pre")).toContainText("Collection date: [blank]");
});

test("selecting a field shows only that field's evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Extracted fields" }).click();
  const evidence = page.getByRole("complementary", { name: "Source evidence" });
  await page.getByRole("button", { name: "Patient ID", exact: true }).click();
  await expect(evidence.locator(".evidence-group")).toHaveCount(1);
  await expect(evidence.getByRole("heading", { name: "Patient ID", exact: true })).toBeVisible();
  await expect(evidence.locator("mark")).toHaveText("Patient ID: SYN-004");
  await page.getByRole("button", { name: "Patient name", exact: true }).click();
  await expect(evidence.locator(".evidence-group")).toHaveCount(1);
  await expect(evidence.getByRole("heading", { name: "Patient name", exact: true })).toBeVisible();
  await expect(evidence.locator("mark")).toHaveText("Patient name: Drew Example");
  await expect(evidence.getByRole("region", { name: "Patient ID evidence", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Issues" }).click();
  await expect(evidence.getByRole("heading", { name: "Date of birth", exact: true })).toBeVisible();
  await expect(evidence.locator(".evidence-hit")).toHaveCount(2);
});

test("warning evidence stays clearly quarantined", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "CASE-005 Emery Example" }).click();
  await page.locator(".warning-list summary").click();
  // Select the unrelated-document warning's citation.
  await page.locator(".warning-list > div").filter({ hasText: "Unrelated document" }).getByRole("button", { name: "View evidence" }).first().click();
  await expect(page.locator(".evidence-hit.is-selected")).toContainText("Quarantined");
  await expect(page.locator(".evidence-hit.is-selected mark")).toHaveText("Case ID: CASE-OTHER-900");
});

test("review requires explicit confirmation and persists edited drafts separately", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Drew Example", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "CASE-002 Blair Example" }).click();
  await expect(page.getByRole("heading", { name: "Blair Example", exact: true })).toBeVisible();
  const button = page.getByRole("button", { name: "Accept analysis" });
  await expect(button).toBeDisabled();
  await page.getByLabel("Reviewer name").fill("Browser test reviewer");
  await page.getByLabel("Follow-up draft", { exact: true }).fill("Please provide the collection date and a signed requisition. Thank you.");
  await page.getByLabel("I checked the source evidence and follow-up draft.").check();
  await button.click();
  await expect(page.getByRole("status")).toContainText("review saved");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Drew Example", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "CASE-002 Blair Example" }).click();
  await expect(page.getByLabel("Follow-up draft", { exact: true })).toHaveValue("Please provide the collection date and a signed requisition. Thank you.");
  await expect(page.getByText("Last reviewed by Browser test reviewer", { exact: false })).toBeVisible();
});

test("mobile review fits the viewport and keeps evidence available", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Drew Example", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await expect(page.getByRole("heading", { name: "Source evidence", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/review-mobile.png", fullPage: true });
});

test("reviewers can queue and open a new analysis without overwriting the previous run", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "CASE-001 Alex Example" }).click();
  await page.getByRole("button", { name: "Reanalyze case", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Analysis queued");
  await page.locator(".operations-panel > summary").click();
  await expect(page.locator(".job-row").first()).toContainText("succeeded", { timeout: 10000 });
  await page.locator(".job-row").first().getByRole("button", { name: "Open analysis" }).click();
  await expect(page.getByRole("heading", { name: "Alex Example", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});


test("reload asks before discarding unsaved draft edits and notes", async ({ page }) => {
  await page.goto("/");
  const draft = page.getByLabel("Follow-up draft", { exact: true });
  await expect(draft).toBeVisible();
  const saved = await draft.inputValue();
  await draft.fill("Unsaved provider follow-up");
  await page.getByLabel("Notes", { exact: false }).fill("Unsaved review notes");
  let dialogs = 0;
  page.once("dialog", (dialog) => { dialogs++; return dialog.dismiss(); });
  await page.getByRole("button", { name: "Reload case" }).click();
  expect(dialogs).toBe(1);
  await expect(draft).toHaveValue("Unsaved provider follow-up");
  await expect(page.getByLabel("Notes", { exact: false })).toHaveValue("Unsaved review notes");
  page.once("dialog", (dialog) => { dialogs++; return dialog.accept(); });
  await page.getByRole("button", { name: "Reload case" }).click();
  expect(dialogs).toBe(2);
  await expect(draft).toHaveValue(saved);
  await expect(page.getByLabel("Notes", { exact: false })).toHaveValue("");
});
