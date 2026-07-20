# Seriva API

Cloudflare Worker API for securely syncing photo, video, and other asset files. Asset bytes live in private R2 storage; users, Auth.js records, asset ownership, and metadata live in D1.

## Authentication

Seriva exposes standard Auth.js endpoints under `/auth/*` with credentials, Google, and Apple providers plus encrypted JWT session cookies. OAuth users and linked provider accounts are persisted through the D1 adapter. Passwords are salted and hashed with Web Crypto PBKDF2; plaintext passwords are never stored.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/auth/register` | Create an email/password account |
| `GET/POST` | `/auth/*` | Standard Auth.js CSRF, sign-in, callback, session, and sign-out routes |
| `GET` | `/v1/auth/me` | Return the authenticated API user |

Registration accepts JSON:

```json
{
  "email": "person@example.com",
  "password": "at-least-12-characters",
  "name": "Person"
}
```

Use the standard Auth.js credentials sign-in flow against `/auth`. Browser requests to protected API routes must include the resulting `seriva.session-token` cookie.

### Google and Apple

OAuth providers are enabled when both secrets for that provider are present. Configure these callback URLs in the provider dashboards:

```text
https://YOUR_API_DOMAIN/auth/callback/google
https://YOUR_API_DOMAIN/auth/callback/apple
```

Install the provider values as Worker secrets:

```sh
npx wrangler secret put AUTH_GOOGLE_ID
npx wrangler secret put AUTH_GOOGLE_SECRET
npx wrangler secret put AUTH_APPLE_ID
npx wrangler secret put AUTH_APPLE_SECRET
```

`AUTH_APPLE_ID` is the Apple Services ID. `AUTH_APPLE_SECRET` is the signed Apple client-secret JWT generated from your Apple team ID, key ID, and private key; rotate it before its configured expiration. Apple requires a registered HTTPS domain for the web OAuth flow.

The standard `GET /auth/providers` response lists the providers currently enabled. OAuth sign-in begins at `/auth/signin/google` or `/auth/signin/apple` and returns through the callback URLs above.

Auth.js deliberately does not automatically link an OAuth identity to an existing password account merely because the email addresses match. That prevents account-takeover vulnerabilities; explicit authenticated account linking can be added later.

To share login with a future Auth.js web application, both applications must use:

- The same D1 database and Auth.js D1 adapter tables.
- The same `AUTH_SECRET`.
- JWT session strategy and the `seriva.session-token` cookie name.
- The same cookie domain, such as `.seriva.example`, when deployed on sibling subdomains.
- Equivalent Credentials provider and JWT/session callbacks so `token.sub` remains the user ID.

## Asset API

Every asset belongs to the authenticated user. Cross-account lookups return `404`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Public service health |
| `POST` | `/v1/assets` | Stream an asset into R2 and create its D1 record |
| `GET` | `/v1/assets?limit=50&cursor=...` | List the current user’s assets |
| `GET` | `/v1/assets/:id` | Read asset metadata |
| `GET` | `/v1/assets/:id/content` | Stream private content with range/conditional request support |
| `PATCH` | `/v1/assets/:id` | Replace filename and custom metadata |
| `DELETE` | `/v1/assets/:id` | Delete content and metadata |

Uploads require `X-File-Name`. `Content-Type` defaults to `application/octet-stream`; optional `X-Seriva-Metadata` must contain a JSON object no larger than 8 KiB.

## Local development

Use Node.js 22 or 24+, install dependencies, then create a git-ignored `.dev.vars`:

```sh
npm install
```

```dotenv
AUTH_SECRET=replace-with-a-long-random-secret
# Optional OAuth providers:
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
AUTH_APPLE_ID=
AUTH_APPLE_SECRET=
```

Apply migrations and start the Worker:

```sh
npx wrangler d1 migrations apply seriva-assets --local
npm run dev
```

Run all validation with `npm run check`.

## Production setup

The current Cloudflare resource bindings are configured in `wrangler.jsonc`. Set `AUTH_COOKIE_DOMAIN` there if the API and web app will use sibling subdomains. Install the same secret used by the web app, then migrate and deploy:

```sh
npx wrangler secret put AUTH_SECRET
npx wrangler d1 migrations apply seriva-assets --remote
npx wrangler deploy --dry-run
npx wrangler deploy
```

Before opening public registration, add edge rate limiting or Turnstile, email verification, password reset, and an account-recovery flow. Auth.js intentionally leaves these credentials-specific controls to the application.
