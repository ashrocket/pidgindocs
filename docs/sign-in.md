# Sign-in

The sign-in page offers email and the providers configured for this instance. Google uses its official button. Microsoft uses the authorization-code flow with PKCE. The Apple endpoints remain available to existing clients, but Apple is no longer offered on the web sign-in page.

Email sign-in sends a five-minute link and an eight-digit code. Either completes the same challenge; the first successful use consumes both. The code works in the browser where sign-in started even when the email is opened elsewhere. Opening the link in a different browser displays the code without consuming the challenge; an explicit same-origin POST can continue in that browser instead. An HttpOnly proof cookie binds code entry to the browser that requested it. Five incorrect code attempts exhaust the challenge. Sending again starts a fresh challenge and remains subject to the existing five-emails-per-ten-minutes limit. A client IP can request at most 30 challenges in ten minutes, including requests for unknown addresses. Existing outstanding links remain usable until expiry, matching the previous link behavior.

Apply `server/migrations/0002_login_challenges.sql` before releasing this code. The tables keep short-lived email challenges and OAuth state, plus stable Microsoft identities. No deployment, migration or live account change is implied by adding these files.

## Microsoft configuration

Register a Microsoft Entra **web** application with the account types appropriate to this instance. Register exactly `<WORKER_URL>/auth/oauth/microsoft/web` as the redirect URI. Set:

- `MICROSOFT_CLIENT_ID`: the application's client ID.
- `MICROSOFT_CLIENT_SECRET`: a server-side secret, stored through Wrangler secrets.
- `MICROSOFT_TENANT_ID`: the allowed tenant UUID, `organizations`, `consumers`, or `common` (the default).
- `WORKER_URL`: this instance's canonical HTTPS origin, with no trailing slash.

The application requests only `openid profile`; it does not request Microsoft Graph access or refresh tokens. Keep the secret out of source and client HTML. The Microsoft button is omitted when its client ID or secret is absent.

Microsoft tokens are checked for signature, issuer, tenant, audience, expiry and nonce. Authorization state is bound to an HttpOnly browser cookie, stored server-side and consumed once. Redirects stay on the configured origin.

Microsoft's `email` and `preferred_username` claims do not establish ownership of an existing PidginDocs account. The user first signs in through email or an already linked provider, opens **Connect Microsoft**, and confirms the Microsoft account. The callback requires that same active PidginDocs session and stores the provider's issuer and subject. Later Microsoft sign-ins resolve that immutable pair to the canonical account. It does not create users or silently merge accounts.

For an operator-assisted revocation, remove only the matching row from `oauth_login_identities` after verifying its `user_id`, issuer and subject. Existing sessions follow the normal session lifetime. A self-service disconnect control is not part of this change.

## Google and linked email addresses

`GOOGLE_WEB_CLIENT_ID` enables Google's web button. Its registered callback is `<WORKER_URL>/auth/oauth/google/web`. Existing identity linking through `POST /api/identities` requires an active session plus a verified provider ID token, rejects an address belonging to another account, and stores the alias against the canonical user. This is the path for connecting a Google address to an existing account; do not infer an account from matching names or add personal address mappings to source.

The reference layout uses the existing PidginDocs bird image, a split desktop composition, a compact sign-in card, and one-column mobile layout. The email-sent and error states use the same composition.

## Verification

Run `npm ci`, `npx tsc --noEmit` and `npm test` in `server/`. The login tests cover shared link/code consumption, expiry, retry bounds, canonical alias resolution, OAuth state reuse, nonce/issuer/audience/tenant/expiry rejection and authenticated Microsoft linking. Provider test tokens are synthetic. A real Google/Microsoft callback and delivered email still require a configured deployment and an authorized account.

Microsoft protocol references: [authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) and [ID-token claim semantics](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).
