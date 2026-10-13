import * as client from "openid-client";
import type { ReviewerIdentity } from "./access-policy.ts";

export type LoginChecks = { state: string; nonce: string; verifier: string };
export type IdentityProvider = {
  authorize(redirectUri: string, checks: LoginChecks): Promise<URL>;
  exchange(callback: URL, checks: LoginChecks): Promise<{ identity: ReviewerIdentity; expiresAt: number }>;
};

export async function oidcProvider(settings: { issuer: string; clientId: string; clientSecret?: string }, fetcher?: client.DiscoveryRequestOptions[typeof client.customFetch]): Promise<IdentityProvider> {
  const issuer = new URL(settings.issuer);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error("Use an HTTPS issuer");
  if (!settings.clientId.trim()) throw new Error("OIDC client ID is required");
  const config = await client.discovery(issuer, settings.clientId, settings.clientSecret,
    settings.clientSecret ? client.ClientSecretPost(settings.clientSecret) : client.None(), {
      execute: [client.enableNonRepudiationChecks], ...(fetcher ? { [client.customFetch]: fetcher } : {}), timeout: 10,
    });
  return {
    async authorize(redirectUri, checks) {
      return client.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: "openid profile",
        state: checks.state, nonce: checks.nonce, code_challenge_method: "S256",
        code_challenge: await client.calculatePKCECodeChallenge(checks.verifier) });
    },
    async exchange(callback, checks) {
      const tokens = await client.authorizationCodeGrant(config, callback, {
        expectedState: checks.state, expectedNonce: checks.nonce, pkceCodeVerifier: checks.verifier, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || !claims.sub || claims.iss !== settings.issuer) throw new Error("Missing verified identity");
      const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.slice(0, 100) : claims.sub.slice(0, 100);
      return { identity: { issuer: claims.iss, subject: claims.sub, name }, expiresAt: claims.exp * 1000 };
    },
  };
}
