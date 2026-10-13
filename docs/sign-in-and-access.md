# Sign-in and case access

## What works

- Standard OpenID Connect sign-in; provider settings stay outside the review logic.
- Authorization code + PKCE, state, nonce, and signed ID-token checks.
- Browser gets an opaque HttpOnly cookie, not provider tokens.
- Sessions last up to 15 minutes; logout removes the app session.
- HTTPS uses Secure cookies; plain HTTP is allowed only on localhost.
- No session or assignment? No case data.
- `viewer` reads assigned cases; `reviewer` can also save decisions.
- Access matches the provider's issuer + subject ID, never a typed name or email.
- Signed-in review records save that identity; old demo records stay readable.
- The policy is reread on each request, so removed assignments stop working immediately.

## Connect a provider

```sh
cp config/access.example.json config/access.local.json
npm run build:ui
```

- Edit the local policy with the exact issuer, user subject IDs, roles, and case IDs.
- Set `OIDC_ISSUER` and `OIDC_CLIENT_ID` through your environment or secret manager.
- Set `OIDC_CLIENT_SECRET` only if the app client requires one; keep it out of Git.
- Register `YOUR_APP_ORIGIN/auth/callback` as the exact callback URL.
- Enable authorization-code sign-in and the `openid profile` scopes.

```sh
npm run serve -- --report runs/evaluations/YOUR_EVALUATION/report.json \
  --auth oidc --access config/access.local.json \
  --origin http://localhost:3000
```

- For a deployed app, use its HTTPS origin and trusted TLS ingress.
- For Docker, mount the access policy read-only and inject provider settings at runtime.
- The example policy is a scaffold; it doesn't grant access to real users.
- Cognito is provisioned; the two demo users still need their first passwords.
- Cognito supports this code flow with PKCE. [AWS guide](https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints-oauth-grants.html)
- Protocol handling uses `openid-client`. [Client docs](https://github.com/panva/openid-client)

## Local demo

- `npm run ui` and the default container remain local synthetic demos.
- Demo reviewer names are self-reported; they don't count as authenticated identities.
- Demo mode rejects a public hostname, rather than silently exposing cases.

## Demo accounts

- AWS pool: `us-west-2_aejvUGWET`; profile `thorson-sandbox1-admin`.
- `viewer-demo`: CASE-001 only, read-only.
- `reviewer-demo`: all five original cases, saved reviewer identity.
- Run `bash scripts/test-sign-in.sh`; passwords are entered privately, never in chat.
- The wizard opens [the deployed demo](https://d325n366v4dizu.cloudfront.net).
- Local settings are in gitignored `.env.oidc` and `config/access.local.json`.
- Software-token MFA is optional; admin-only account creation and recovery.

## Limits and checks

- Live Cognito sign-in, case denial, trusted saved identity, viewer write denial, and logout passed.
- Temporary QA accounts and credentials are deleted; original assignments are restored.
- The redirect regression test keeps public homepage navigation working while APIs stay protected.
- Access/login/review events are audited; request rates are limited.
- Assignment management is an operator file/SSM parameter, not an admin UI.
- Session restart signs users out; saved reviews remain on disk.
- App logout doesn't end Cognito's SSO session.
- Shared session storage is needed for multiple app instances.
- These controls don't authorize real patient data or establish compliance.
