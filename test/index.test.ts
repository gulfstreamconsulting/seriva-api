import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, object_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK (byte_size >= 0), etag TEXT NOT NULL, custom_metadata TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'deleting')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT NOT NULL PRIMARY KEY, name TEXT, email TEXT UNIQUE, emailVerified DATETIME, image TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS password_credentials (user_id TEXT NOT NULL PRIMARY KEY, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
  await env.DB.prepare("ALTER TABLE assets ADD COLUMN owner_id TEXT").run();
});

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
}

async function registerAndLogin(email: string): Promise<string> {
  const password = "a-secure-test-password";
  const registration = await SELF.fetch("https://example.com/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "Test User" }),
  });
  expect(registration.status).toBe(201);

  const csrf = await SELF.fetch("https://example.com/auth/csrf");
  const csrfBody = await csrf.json<{ csrfToken: string }>();
  const callback = await SELF.fetch("https://example.com/auth/callback/credentials", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies(csrf),
      "x-auth-return-redirect": "1",
    },
    body: new URLSearchParams({ csrfToken: csrfBody.csrfToken, email, password, redirectTo: "/" }),
  });
  expect(callback.status).toBe(200);
  const sessionCookie = cookies(callback);
  expect(sessionCookie).toContain("seriva.session-token=");
  return sessionCookie;
}

describe("seriva API", () => {
  it("serves a public health check", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("requires authentication for assets", async () => {
    const response = await SELF.fetch("https://example.com/v1/assets");
    expect(response.status).toBe(401);
  });

  it("exposes every configured Auth.js login provider", async () => {
    const response = await SELF.fetch("https://example.com/auth/providers");
    expect(response.status).toBe(200);
    const providers = await response.json<Record<string, unknown>>();
    expect(Object.keys(providers)).toEqual(expect.arrayContaining(["credentials", "google", "apple"]));
  });

  it("uploads, lists, downloads, updates, and deletes an asset", async () => {
    const auth = { cookie: await registerAndLogin("asset-owner@example.com") };
    const currentUser = await SELF.fetch("https://example.com/v1/auth/me", { headers: auth });
    expect(currentUser.status).toBe(200);
    await expect(currentUser.json()).resolves.toMatchObject({ user: { email: "asset-owner@example.com" } });

    const uploaded = await SELF.fetch("https://example.com/v1/assets", {
      method: "POST",
      headers: { ...auth, "content-type": "image/jpeg", "x-file-name": "photo.jpg" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(uploaded.status).toBe(201);
    const payload = await uploaded.json<{ asset: { id: string; filename: string; byteSize: number } }>();
    expect(payload.asset).toMatchObject({ filename: "photo.jpg", byteSize: 4 });

    const listed = await SELF.fetch("https://example.com/v1/assets", { headers: auth });
    expect(listed.status).toBe(200);
    const list = await listed.json<{ assets: Array<{ id: string }> }>();
    expect(list.assets.some((asset) => asset.id === payload.asset.id)).toBe(true);

    const otherUserCookie = await registerAndLogin("other-user@example.com");
    const forbidden = await SELF.fetch(`https://example.com/v1/assets/${payload.asset.id}`, {
      headers: { cookie: otherUserCookie },
    });
    expect(forbidden.status).toBe(404);

    const content = await SELF.fetch(`https://example.com/v1/assets/${payload.asset.id}/content`, { headers: auth });
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));

    const updated = await SELF.fetch(`https://example.com/v1/assets/${payload.asset.id}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ filename: "renamed.jpg", metadata: { favorite: true } }),
    });
    expect(updated.status).toBe(200);

    const removed = await SELF.fetch(`https://example.com/v1/assets/${payload.asset.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(removed.status).toBe(204);
  });
});
