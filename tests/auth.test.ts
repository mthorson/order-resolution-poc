import assert from "node:assert/strict";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startReviewServer } from "../src/ui-server.ts";
import { reviewWorkspace } from "./helpers/review-workspace.ts";
import { parseAccessPolicy, type ReviewerIdentity } from "../src/access-policy.ts";
import type { IdentityProvider } from "../src/oidc-provider.ts";
import { Auth } from "../src/auth.ts";

test("HTTPS sessions use protected cookies and expire; expired login transactions cannot exchange tokens", async () => {
  let now = 1000;
  let exchanges = 0;
  const provider: IdentityProvider = {
    async authorize(_redirect, checks) { return new URL(`https://identity.example/authorize?state=${checks.state}`); },
    async exchange() { exchanges++; return { identity: { issuer: "https://identity.example", subject: "user", name: "User" }, expiresAt: now + 1000 }; },
  };
  const auth = new Auth(provider, "https://review.example", () => now);
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) { headers.set(name, value); },
    writeHead(_status: number, values: Record<string, string>) { for (const [name, value] of Object.entries(values)) headers.set(name, value); },
    end() {},
  } as unknown as ServerResponse;
  const req = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
  await auth.login(response);
  const loginCookie = headers.get("Set-Cookie")!;
  assert.match(loginCookie, /^__Host-review-login=/);
  assert.match(loginCookie, /HttpOnly; SameSite=Lax.*Secure/);
  const state = new URL(headers.get("Location")!).searchParams.get("state");
  await auth.callback(req(loginCookie.split(";")[0]), response,
    new URL(`https://review.example/auth/callback?code=x&state=${state}`), async () => true);
  const sessionCookie = headers.get("Set-Cookie")!;
  assert.match(sessionCookie, /^__Host-review-session=/);
  assert.match(sessionCookie, /HttpOnly; SameSite=Lax.*Secure/);
  assert.equal(auth.session(req(sessionCookie.split(";")[0]))?.identity.subject, "user");
  now += 1001;
  assert.equal(auth.session(req(sessionCookie.split(";")[0])), null);
  await auth.login(response);
  const pendingCookie = headers.get("Set-Cookie")!.split(";")[0];
  const pendingState = new URL(headers.get("Location")!).searchParams.get("state");
  now += 300_001;
  await assert.rejects(auth.callback(req(pendingCookie), response,
    new URL(`https://review.example/auth/callback?code=x&state=${pendingState}`), async () => true));
  assert.equal(exchanges, 1);
  assert.throws(() => new Auth(provider, "http://review.example"), /HTTPS/);
});

test("policy rejects duplicates and grants no wildcard or implicit role", () => {
  const assignment = { issuer: "https://login.example", subject: "user", role: "reviewer", caseIds: ["CASE-001"] };
  assert.throws(() => parseAccessPolicy({ assignments: [assignment, assignment] }), /Duplicate/);
  assert.throws(() => parseAccessPolicy({ assignments: [{ ...assignment, role: "admin" }] }));
  assert.throws(() => parseAccessPolicy({ assignments: [{ ...assignment, caseIds: ["*"] }] }));
});

test("sign-in binds browser transactions, limits cases and roles, records trusted identity, and revokes sessions", async () => {
  const workspace = await reviewWorkspace(2);
  const accessPath = join(workspace.root, "access.json");
  const assignments = [
    { issuer: "https://login.example", subject: "viewer", role: "viewer", caseIds: ["CASE-001"] },
    { issuer: "https://login.example", subject: "reviewer", role: "reviewer", caseIds: ["CASE-002"] },
  ];
  await writeFile(accessPath, JSON.stringify({ assignments }));
  let identity: ReviewerIdentity = { issuer: "https://login.example", subject: "viewer", name: "Trusted viewer" };
  const provider: IdentityProvider = {
    async authorize(_redirect, checks) { return new URL(`https://login.example/authorize?state=${checks.state}`); },
    async exchange() { return { identity, expiresAt: Date.now() + 3_600_000 }; },
  };
  const app = await startReviewServer(workspace.root, workspace.reportPath, 0, {
    frontend: "none", publicOrigin: "http://localhost", authentication: { provider, accessPath },
  });
  const call = (path: string, cookie = "", token = "", body?: unknown) => new Promise<{
    status: number; data: any; cookie: string; location: string;
  }>((resolve, reject) => {
    const req = request(`${app.origin}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Host: "localhost", Cookie: cookie, "X-Review-Token": token, "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({
        status: res.statusCode!, data: text ? JSON.parse(text) : null,
        cookie: res.headers["set-cookie"]?.[0].split(";")[0] ?? "", location: res.headers.location ?? "",
      }); });
    });
    req.once("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const login = async () => {
    const start = await call("/auth/login");
    const state = new URL(start.location).searchParams.get("state")!;
    const callback = `/auth/callback?code=verified-by-test-provider&state=${state}`;
    const response = await call(callback, start.cookie);
    assert.equal(response.status, 302);
    assert.equal((await call(callback, start.cookie)).status, 401); // Replay rejected.
    const session = await call("/api/session", response.cookie);
    return { cookie: response.cookie, token: session.data.token };
  };
  try {
    assert.equal((await call("/api/cases")).status, 401);
    assert.equal((await call("/api/session")).data.authenticated, false);
    const start = await call("/auth/login");
    const state = new URL(start.location).searchParams.get("state")!;
    assert.equal((await call(`/auth/callback?code=x&state=${state}`)).status, 401); // No browser cookie.
    assert.equal((await call("/auth/callback?code=x&state=wrong", start.cookie)).status, 401);
    const viewer = await login();
    const visible = await call("/api/cases", viewer.cookie, viewer.token);
    assert.deepEqual(visible.data.cases.map((item: { caseId: string }) => item.caseId), ["CASE-001"]);
    const firstRun = visible.data.cases[0].runId;
    assert.equal((await call(`/api/cases/${firstRun}/reviews`, viewer.cookie, viewer.token, {})).status, 403);
    identity = { ...identity, subject: "reviewer", name: "Trusted reviewer" };
    const reviewer = await login();
    const list = await call("/api/cases", reviewer.cookie, reviewer.token);
    const run = list.data.cases[0].runId;
    assert.equal((await call(`/api/cases/${run}`, viewer.cookie, viewer.token)).status, 404);
    assert.equal((await call(`/api/cases/${firstRun}`, reviewer.cookie, reviewer.token)).status, 404);
    assert.equal((await call("/api/cases", viewer.cookie, reviewer.token)).status, 403);
    const detail = (await call(`/api/cases/${run}`, reviewer.cookie, reviewer.token)).data;
    const saved = await call(`/api/cases/${run}/reviews`, reviewer.cookie, reviewer.token, {
      snapshotId: detail.bundle.snapshotId, resultSha256: detail.resultSha256, expectedReviewId: null,
      reviewer: "Forged reviewer", decision: "accepted", notes: "", draftBody: detail.result.followUpDraft.body, evidenceChecked: true,
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.reviewer, "Trusted reviewer");
    assert.deepEqual(saved.data.reviewerIdentity, { issuer: "https://login.example", subject: "reviewer" });
    assert.equal((await call(`/api/cases/${run}`, reviewer.cookie, reviewer.token)).data.review.reviewerIdentity.subject, "reviewer");
    assert.equal((await call("/api/logout", reviewer.cookie, reviewer.token, {})).status, 200);
    assert.equal((await call("/api/cases", reviewer.cookie, reviewer.token)).status, 401);
    await writeFile(accessPath, JSON.stringify({ assignments: [] }));
    assert.equal((await call("/api/cases", viewer.cookie, viewer.token)).status, 401);
  } finally { await app.close(); await rm(workspace.root, { recursive: true, force: true }); }
});
