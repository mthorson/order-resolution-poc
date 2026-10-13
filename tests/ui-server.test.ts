import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";
import { startReviewServer } from "../src/ui-server.ts";
import { reviewWorkspace } from "./helpers/review-workspace.ts";

test("local API protects access, serves selected cases, and records only explicit review decisions", async () => {
  const workspace = await reviewWorkspace();
  const app = await startReviewServer(workspace.root, workspace.reportPath, 0, { frontend: "none" });
  try {
    assert.equal((await fetch(`${app.origin}/api/cases`)).status, 403);
    assert.equal((await fetch(`${app.origin}/api/session`, { headers: { Origin: "https://other.example" } })).status, 403);
    const session = await (await fetch(`${app.origin}/api/session`)).json();
    const headers = { "X-Review-Token": session.token, "Content-Type": "application/json" };
    const list = await (await fetch(`${app.origin}/api/cases`, { headers })).json();
    const runId = list.cases[0].runId;
    const detail = await (await fetch(`${app.origin}/api/cases/${runId}`, { headers })).json();
    const saved = await fetch(`${app.origin}/api/cases/${runId}/reviews`, { method: "POST", headers,
      body: JSON.stringify({ snapshotId: detail.bundle.snapshotId, resultSha256: detail.resultSha256,
        expectedReviewId: null, reviewer: "Test reviewer", decision: "accepted", notes: "", draftBody: null, evidenceChecked: true }) });
    assert.equal(saved.status, 201);
    assert.equal((await saved.json()).decision, "accepted");
    const foreign = await fetch(`${app.origin}/api/cases/${runId}/reviews`, { method: "POST",
      headers: { ...headers, Origin: "https://other.example" }, body: "{}" });
    assert.equal(foreign.status, 403);
    assert.equal((await fetch(`${app.origin}/api/cases/00000000-0000-0000-0000-000000000000`, { headers })).status, 404);
  } finally { await app.close(); await rm(workspace.root, { recursive: true, force: true }); }
});

test("built server serves assets, preserves API guards, and blocks source paths and symlinks", async () => {
  const workspace = await reviewWorkspace();
  const dist = join(workspace.root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), '<html><script src="/assets/app-123.js"></script></html>');
  await writeFile(join(dist, "assets/app-123.js"), "console.log('built UI')");
  await writeFile(join(workspace.root, "private.txt"), "not public");
  await symlink(join(workspace.root, "private.txt"), join(dist, "assets/escape.js"));
  const app = await startReviewServer(workspace.root, workspace.reportPath, 0, { frontend: "built" });
  try {
    const page = await fetch(app.origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(await page.text(), /app-123/);
    const asset = await fetch(`${app.origin}/assets/app-123.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type")!, /javascript/);
    assert.equal((await fetch(`${app.origin}/assets/app-123.js`, { method: "HEAD" })).status, 200);
    for (const path of ["/src/contracts.ts", "/runs/demo-report.json", "/assets/escape.js", "/assets/missing.js", "/@vite/client"]) {
      assert.equal((await fetch(`${app.origin}${path}`)).status, 404);
    }
    assert.equal((await fetch(app.origin, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${app.origin}/api/cases`)).status, 403);
    assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
    const session = await (await fetch(`${app.origin}/api/session`)).json();
    assert.equal((await fetch(`${app.origin}/api/cases`, { headers: { "X-Review-Token": session.token } })).status, 200);
  } finally { await app.close(); await rm(workspace.root, { recursive: true, force: true }); }
});

test("network binding needs an explicit origin and missing builds fail before listening", async () => {
  const workspace = await reviewWorkspace();
  try {
    await assert.rejects(startReviewServer(workspace.root, workspace.reportPath, 0, { host: "0.0.0.0", frontend: "none" }), /explicit public origin/);
    await assert.rejects(startReviewServer(workspace.root, workspace.reportPath, 0, { frontend: "built" }), /ENOENT/);
    const app = await startReviewServer(workspace.root, workspace.reportPath, 0, {
      frontend: "none", publicOrigin: "https://localhost",
    });
    try {
      assert.equal((await fetch(`${app.origin}/api/session`)).status, 403);
      const status = (origin: string) => new Promise<number>((resolve, reject) => {
        const req = request(`${app.origin}/api/session`, { headers: { Host: "localhost", Origin: origin } }, (response) => {
          response.resume(); resolve(response.statusCode!);
        });
        req.once("error", reject); req.end();
      });
      assert.equal(await status("https://localhost"), 200);
      assert.equal(await status("https://other.example"), 403);
    } finally { await app.close(); }
  } finally { await rm(workspace.root, { recursive: true, force: true }); }
});

test("OIDC redirects can land on the public document while cross-site APIs stay blocked", async () => {
  const workspace = await reviewWorkspace();
  await mkdir(join(workspace.root, "dist"));
  await writeFile(join(workspace.root, "dist/index.html"), "<html>Review sign-in</html>");
  await writeFile(join(workspace.root, "access.json"), JSON.stringify({ assignments: [] }));
  const app = await startReviewServer(workspace.root, workspace.reportPath, 0, {
    frontend: "built", publicOrigin: "http://localhost",
    authentication: { accessPath: join(workspace.root, "access.json"), provider: {
      async authorize() { return new URL("https://identity.example/login"); },
      async exchange() { throw new Error("Not called by a public landing"); },
    } },
  });
  const status = (path: string, headers: Record<string, string>, method = "GET") => new Promise<number>((resolve, reject) => {
    const req = request(`${app.origin}${path}`, { method, headers: { Host: "localhost", ...headers } }, (res) => {
      res.resume(); resolve(res.statusCode!);
    });
    req.once("error", reject); req.end();
  });
  try {
    const navigation = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    assert.equal(await status("/", navigation), 200);
    assert.equal(await status("/api/session", navigation), 403);
    assert.equal(await status("/api/cases", navigation), 403);
    assert.equal(await status("/", navigation, "POST"), 403);
    assert.equal(await status("/", { "Sec-Fetch-Site": "cross-site" }), 403);
    assert.equal(await status("/", { ...navigation, Origin: "https://other.example" }), 403);
  } finally { await app.close(); await rm(workspace.root, { recursive: true, force: true }); }
});
