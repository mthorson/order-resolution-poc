import assert from "node:assert/strict";
import { test } from "node:test";
import * as client from "openid-client";
import { oidcProvider } from "../src/oidc-provider.ts";

test("OIDC validates signed identity, issuer, audience, expiration, nonce, state, and PKCE", async () => {
  const issuer = "https://identity.example";
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const wrongKeys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "key", alg: "RS256", use: "sig" };
  const checks = { state: "expected-state", nonce: "expected-nonce", verifier: client.randomPKCECodeVerifier() };
  let change: Record<string, unknown> = {};
  let wrongSignature = false;
  let exchanges = 0;
  const fetcher: client.CustomFetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/.well-known/openid-configuration") return Response.json({ issuer,
      authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
    if (path === "/jwks") return Response.json({ keys: [publicKey] });
    assert.equal(path, "/token");
    exchanges++;
    const body = new URLSearchParams(String(options.body));
    assert.equal(body.get("code_verifier"), checks.verifier);
    assert.equal(body.get("grant_type"), "authorization_code");
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const data = `${encode({ alg: "RS256", kid: "key" })}.${encode({ iss: issuer, sub: "trusted-user", aud: "review-app",
      iat: now, exp: now + 3600, nonce: checks.nonce, name: "Test reviewer", ...change })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", wrongSignature ? wrongKeys.privateKey : keys.privateKey, Buffer.from(data));
    return Response.json({ token_type: "Bearer", access_token: "unused", expires_in: 3600,
      id_token: `${data}.${Buffer.from(signature).toString("base64url")}` });
  };
  const provider = await oidcProvider({ issuer, clientId: "review-app" }, fetcher);
  const authorization = await provider.authorize("https://review.example/auth/callback", checks);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("code_challenge"), await client.calculatePKCECodeChallenge(checks.verifier));
  const callback = new URL(`https://review.example/auth/callback?code=example-code&state=${checks.state}`);
  const result = await provider.exchange(callback, checks);
  assert.deepEqual(result.identity, { issuer, subject: "trusted-user", name: "Test reviewer" });
  const before = exchanges;
  await assert.rejects(provider.exchange(new URL("https://review.example/auth/callback?code=x&state=wrong"), checks));
  assert.equal(exchanges, before);
  for (const invalid of [{ iss: "https://other.example" }, { aud: "other-app" },
    { exp: 1 }, { nonce: "wrong-nonce" }]) {
    change = invalid;
    await assert.rejects(provider.exchange(callback, checks));
  }
  change = {}; wrongSignature = true;
  await assert.rejects(provider.exchange(callback, checks));
  await assert.rejects(oidcProvider({ issuer: "http://identity.example", clientId: "review-app" }, fetcher), /HTTPS issuer/);
});
