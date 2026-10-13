import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ReviewStore, ReviewStoreError } from "./review-store.ts";
import { staticFrontend } from "./static-frontend.ts";
import { Auth } from "./auth.ts";
import { accessFor, parseAccessPolicy } from "./access-policy.ts";
import type { IdentityProvider } from "./oidc-provider.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JobStore } from "./job-store.ts";
import { JobRunner } from "./job-runner.ts";
import { loadCase } from "./load-case.ts";
import { summarizeMetrics } from "./metrics.ts";

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65536) throw new ReviewStoreError(413, "Review request is too large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ReviewStoreError(400, "Invalid review request"); }
}

export type ReviewServerOptions = {
  frontend?: "development" | "built" | "none";
  frontendRoot?: string;
  host?: "127.0.0.1" | "0.0.0.0";
  publicOrigin?: string;
  authentication?: { provider: IdentityProvider; accessPath: string };
  jobModel?: { model: string; region: string };
};

export async function startReviewServer(root: string, reportPath: string, port: number, options: ReviewServerOptions = {}) {
  const hostAddress = options.host ?? "127.0.0.1";
  if (hostAddress === "0.0.0.0" && !options.publicOrigin) throw new Error("Network binding requires an explicit public origin");
  const publicUrl = options.publicOrigin ? new URL(options.publicOrigin) : null;
  if (publicUrl && (!/^https?:$/.test(publicUrl.protocol) || publicUrl.username || publicUrl.password ||
    publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash)) throw new Error("Supply a plain HTTP(S) origin");
  const frontend = options.frontend ?? "development";
  if (!options.authentication && publicUrl && !["localhost", "127.0.0.1"].includes(publicUrl.hostname)) throw new Error("Demo access must stay on localhost");
  if (options.authentication && !publicUrl) throw new Error("Sign-in needs an explicit public origin");
  const auth = options.authentication ? new Auth(options.authentication.provider, publicUrl!.origin) : null;
  const assignment = async (identity: Parameters<typeof accessFor>[1]) => accessFor(options.authentication!.accessPath, identity);
  if (options.authentication) parseAccessPolicy(JSON.parse(await readFile(options.authentication.accessPath, "utf8")));
  const frontendRoot = options.frontendRoot ?? root;
  const serveStatic = frontend === "built" ? await staticFrontend(`${frontendRoot}/dist`) : null;
  const store = await ReviewStore.open(root, reportPath);
  await store.list(); // Refuse startup if saved evidence or fixture snapshots changed.
  const jobs = new JobStore(join(root, "runs"));
  const runner = await JobRunner.start(root, jobs, (job) => store.register(job.runId, job.patientFolder), options.jobModel ?? null);
  const token = randomUUID();
  const requestCounts = new Map<string, { count: number; expires: number }>();
  let origin = "";
  let vite: Awaited<ReturnType<typeof import("vite")["createServer"]>> | null = null;
  function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    response.end(JSON.stringify(body));
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/healthz" && request.method === "GET") {
        json(response, 200, { status: "ok" }); return;
      }
      const host = request.headers.host;
      const allowedHosts = publicUrl ? [publicUrl.host] : [new URL(origin).host, new URL(origin.replace("127.0.0.1", "localhost")).host];
      if (!host || !allowedHosts.includes(host)) {
        json(response, 403, { error: "Local access only" }); return;
      }
      const callback = request.url?.split("?")[0] === "/auth/callback" && request.method === "GET" && auth;
      // Provider redirects remain cross-site through the final homepage navigation.
      // Only the public document landing is allowed; case APIs retain every guard.
      const loginLanding = auth && request.method === "GET" && request.url?.split("?")[0] === "/" &&
        request.headers["sec-fetch-mode"] === "navigate" && request.headers["sec-fetch-dest"] === "document";
      if (!callback && ((request.headers["sec-fetch-site"] === "cross-site" && !loginLanding) ||
        (request.headers.origin && request.headers.origin !== (publicUrl?.origin ?? `http://${host}`)))) {
        json(response, 403, { error: "Cross-origin access is not allowed" }); return;
      }
      const url = new URL(request.url ?? "/", origin);
      const identity = auth?.session(request)?.identity;
      const rateKey = identity ? JSON.stringify([identity.issuer, identity.subject]) : request.socket.remoteAddress ?? "anonymous";
      const now = Date.now();
      for (const [key, value] of requestCounts) if (value.expires <= now) requestCounts.delete(key);
      const counter = requestCounts.get(rateKey) ?? { count: 0, expires: now + 60_000 };
      counter.count++; requestCounts.set(rateKey, counter);
      if (counter.count > (identity || !auth ? 300 : 60)) {
        response.setHeader("Retry-After", "60"); json(response, 429, { error: "Too many requests. Wait a minute and try again" }); return;
      }
      if (auth && url.pathname === "/auth/login" && request.method === "GET") {
        jobs.audit("sign_in_started", "anonymous");
        await auth.login(response); return;
      }
      if (callback) {
        try {
          const identity = await auth!.callback(request, response, new URL(request.url!, auth!.origin), async (identity) => Boolean(await assignment(identity)));
          jobs.audit("signed_in", JSON.stringify([identity.issuer, identity.subject]));
        }
        catch { jobs.audit("sign_in_failed", "anonymous"); json(response, 401, { error: "Sign-in failed or no case access is assigned. Return to the app and try again" }); }
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const session = auth?.session(request) ?? null;
        const access = session ? await assignment(session.identity) : null;
        const actor = session ? JSON.stringify([session.identity.issuer, session.identity.subject]) : "demo";
        if (url.pathname === "/api/session" && request.method === "GET") {
          json(response, 200, auth ? session && access
            ? { token: session.token, authenticated: true, authentication: "oidc", reviewer: session.identity.name, role: access.role }
            : { authenticated: false, authentication: "oidc", loginUrl: "/auth/login" }
            : { token, authenticated: true, authentication: "demo", role: "reviewer" }); return;
        }
        if (auth && (!session || !access)) { json(response, 401, { error: "Sign in to view this case" }); return; }
        if (request.headers["x-review-token"] !== (session?.token ?? token)) {
          json(response, 403, { error: "Reload the page to open a local review session" }); return;
        }
        if (auth && url.pathname === "/api/logout" && request.method === "POST") {
          jobs.audit("signed_out", actor);
          auth.logout(request, response); json(response, 200, { signedOut: true }); return;
        }
        if (url.pathname === "/api/cases" && request.method === "GET") {
          jobs.audit("case_queue_viewed", actor);
          json(response, 200, { cases: await store.list(access ? new Set(access.caseIds) : undefined) }); return;
        }
        if (url.pathname === "/api/operations" && request.method === "GET") {
          const allowed = access ? new Set(access.caseIds) : undefined;
          const visible = await store.list(allowed);
          const details = await Promise.all(visible.map((item) => store.detail(item.runId)));
          const visibleJobs = jobs.list(allowed);
          json(response, 200, { jobs: visibleJobs, metrics: summarizeMetrics(details, visibleJobs), mode: runner.mode() }); return;
        }
        const cancellation = /^\/api\/jobs\/([a-f0-9-]{36})\/cancel$/.exec(url.pathname);
        if (cancellation && request.method === "POST") {
          const job = jobs.get(cancellation[1]);
          if (access && !access.caseIds.includes(job.caseId)) { json(response, 404, { error: "Job not found" }); return; }
          if (access?.role === "viewer") { json(response, 403, { error: "Reviewer access is required" }); return; }
          json(response, 200, runner.cancel(job.id)); return;
        }
        const reanalysis = /^\/api\/cases\/([a-f0-9-]{36})\/reanalyze$/.exec(url.pathname);
        if (reanalysis && request.method === "POST") {
          const caseId = store.caseId(reanalysis[1]);
          if (access && !access.caseIds.includes(caseId)) { json(response, 404, { error: "Case not found" }); return; }
          if (access?.role === "viewer") { json(response, 403, { error: "Reviewer access is required" }); return; }
          const patientFolder = store.patientFolder(reanalysis[1]);
          const bundle = await loadCase(join(root, store.caseRoot, patientFolder));
          if (bundle.caseId !== caseId) { json(response, 409, { error: "Case identity changed; check the source files" }); return; }
          const key = request.headers["idempotency-key"];
          if (typeof key !== "string") { json(response, 400, { error: "Supply an idempotency key" }); return; }
          try { json(response, 202, jobs.enqueue({ caseId, patientFolder, snapshotId: bundle.snapshotId, caseRoot: store.caseRoot, mode: runner.mode() }, actor, key)); }
          catch { json(response, 409, { error: "Request conflicts with an earlier job or the daily job limit" }); }
          return;
        }
        const match = /^\/api\/cases\/([a-f0-9-]{36})(\/reviews)?$/.exec(url.pathname);
        if (match && access && !access.caseIds.includes(store.caseId(match[1]))) {
          jobs.audit("case_access_denied", actor, store.caseId(match[1]), match[1]);
          json(response, 404, { error: "Case not found" }); return;
        }
        if (match && !match[2] && request.method === "GET") {
          jobs.audit("case_viewed", actor, store.caseId(match[1]), match[1]);
          json(response, 200, await store.detail(match[1])); return;
        }
        if (match && match[2] && request.method === "POST") {
          if (access?.role === "viewer") { json(response, 403, { error: "Reviewer access is required to save a decision" }); return; }
          if (!request.headers["content-type"]?.startsWith("application/json")) {
            json(response, 415, { error: "Use a JSON review request" }); return;
          }
          const review = await store.save(match[1], await readJson(request), session?.identity);
          jobs.audit("review_saved", actor, store.caseId(match[1]), review.reviewId);
          json(response, 201, review); return;
        }
        json(response, 404, { error: "Review endpoint not found" }); return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Referrer-Policy", "no-referrer");
      if (serveStatic) await serveStatic(request, response, url.pathname);
      else if (vite) vite.middlewares(request, response);
      else { response.writeHead(404); response.end("Not found"); }
    } catch (error) {
      json(response, error instanceof ReviewStoreError ? error.status : 500,
        { error: error instanceof ReviewStoreError ? error.message : "Could not load or save this review. Check the saved files" });
    }
  });
  try {
  if (frontend === "development") {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({ configFile: `${frontendRoot}/vite.config.ts`,
      server: { middlewareMode: true, ws: { server } } });
  }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, hostAddress, resolve); });
  } catch (error) { await vite?.close(); await runner.close(); jobs.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine local port");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, store, close: async () => {
    await runner.close(); jobs.close();
    await vite?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
