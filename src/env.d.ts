// Secrets cannot be declared in wrangler.jsonc, so this augments Wrangler's
// generated Env with the secret installed via `wrangler secret put AUTH_SECRET`.
interface Env {
  AUTH_SECRET: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  AUTH_APPLE_ID?: string;
  AUTH_APPLE_SECRET?: string;
}
