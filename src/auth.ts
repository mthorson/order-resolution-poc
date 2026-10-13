import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReviewerIdentity } from "./access-policy.ts";
import type { IdentityProvider, LoginChecks } from "./oidc-provider.ts";

type Session = { identity: ReviewerIdentity; token: string; expiresAt: number };
type PendingLogin = { checks: LoginChecks; expiresAt: number };
const random = () => randomBytes(32).toString("base64url");

export class Auth {
  private readonly sessions = new Map<string, Session>();
  private readonly logins = new Map<string, PendingLogin>();
  private readonly secure: boolean;
  private readonly cookieName: string;
  private readonly loginCookieName: string;
  private readonly provider: IdentityProvider;
  readonly origin: string;
  private readonly now: () => number;
  constructor(provider: IdentityProvider, origin: string, now = Date.now) {
    this.provider = provider; this.origin = origin; this.now = now;
    const url = new URL(origin);
    this.secure = url.protocol === "https:";
    if (!this.secure && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Sign-in requires HTTPS outside localhost");
    this.cookieName = this.secure ? "__Host-review-session" : "review-session";
    this.loginCookieName = this.secure ? "__Host-review-login" : "review-login";
  }
  private cookie(request: IncomingMessage, name: string): string | undefined {
    const values = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
    return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
  }
  private setCookie(response: ServerResponse, name: string, value: string, age: number) {
    response.setHeader("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.secure ? "; Secure" : ""}`);
  }
  private prune() {
    for (const [id, item] of this.sessions) if (item.expiresAt <= this.now()) this.sessions.delete(id);
    for (const [id, item] of this.logins) if (item.expiresAt <= this.now()) this.logins.delete(id);
  }
  session(request: IncomingMessage): Session | null {
    this.prune();
    return this.sessions.get(this.cookie(request, this.cookieName) ?? "") ?? null;
  }
  async login(response: ServerResponse) {
    this.prune();
    if (this.logins.size >= 1000) throw new Error("Too many pending sign-ins");
    const id = random();
    const checks = { state: random(), nonce: random(), verifier: random() };
    const target = await this.provider.authorize(`${this.origin}/auth/callback`, checks);
    this.logins.set(id, { checks, expiresAt: this.now() + 5 * 60_000 });
    this.setCookie(response, this.loginCookieName, id, 300);
    response.writeHead(302, { Location: target.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); response.end();
  }
  async callback(request: IncomingMessage, response: ServerResponse, url: URL, permitted: (identity: ReviewerIdentity) => Promise<boolean>) {
    this.prune();
    const id = this.cookie(request, this.loginCookieName) ?? "";
    const pending = this.logins.get(id);
    this.logins.delete(id); // A callback can consume this transaction only once.
    if (!pending || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== pending.checks.state) throw new Error("Invalid sign-in transaction");
    const result = await this.provider.exchange(url, pending.checks);
    if (result.expiresAt <= this.now() || !await permitted(result.identity)) throw new Error("Sign-in has no case access");
    if (this.sessions.size >= 1000) throw new Error("Too many sessions");
    const old = this.cookie(request, this.cookieName);
    if (old) this.sessions.delete(old);
    const sessionId = random();
    const expiresAt = Math.min(result.expiresAt, this.now() + 15 * 60_000);
    this.sessions.set(sessionId, { identity: result.identity, token: random(), expiresAt });
    this.setCookie(response, this.cookieName, sessionId, Math.floor((expiresAt - this.now()) / 1000));
    response.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); response.end();
    return result.identity;
  }
  logout(request: IncomingMessage, response: ServerResponse) {
    this.sessions.delete(this.cookie(request, this.cookieName) ?? "");
    this.setCookie(response, this.cookieName, "", 0);
  }
}
