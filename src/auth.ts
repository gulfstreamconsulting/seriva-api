import { Auth, type AuthConfig } from "@auth/core";
import { D1Adapter } from "@auth/d1-adapter";
import Credentials from "@auth/core/providers/credentials";
import Google from "@auth/core/providers/google";
import Apple from "@auth/core/providers/apple";
import type { Provider } from "@auth/core/providers";
import { getToken } from "@auth/core/jwt";

export const SESSION_COOKIE_NAME = "seriva.session-token";
const PASSWORD_ITERATIONS = 100_000;
const MAX_AUTH_BODY_BYTES = 8 * 1024;

type UserRow = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
};

export type AuthenticatedUser = { id: string; email: string };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = Uint8Array.from(salt).buffer;
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function verifyPassword(password: string, user: UserRow): Promise<boolean> {
  const actual = await derivePassword(password, base64ToBytes(user.password_salt), user.password_iterations);
  const expected = base64ToBytes(user.password_hash);
  if (actual.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < actual.byteLength; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function providers(env: Env): Provider[] {
  const configured: Provider[] = [
    Credentials({
      credentials: {
        email: { type: "email", label: "Email" },
        password: { type: "password", label: "Password" },
      },
      async authorize(credentials) {
        if (typeof credentials.email !== "string" || typeof credentials.password !== "string") return null;
        const user = await env.DB.prepare(
          `SELECT users.id, users.name, users.email, users.image,
                  password_credentials.password_hash, password_credentials.password_salt,
                  password_credentials.password_iterations
           FROM users JOIN password_credentials ON password_credentials.user_id = users.id
           WHERE users.email = ?`,
        ).bind(normalizeEmail(credentials.email)).first<UserRow>();
        if (!user || !(await verifyPassword(credentials.password, user))) return null;
        return { id: user.id, name: user.name, email: user.email, image: user.image };
      },
    }),
  ];

  if (Boolean(env.AUTH_GOOGLE_ID) !== Boolean(env.AUTH_GOOGLE_SECRET)) {
    throw new Error("Google authentication requires both AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET");
  }
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    configured.push(Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }));
  }

  if (Boolean(env.AUTH_APPLE_ID) !== Boolean(env.AUTH_APPLE_SECRET)) {
    throw new Error("Apple authentication requires both AUTH_APPLE_ID and AUTH_APPLE_SECRET");
  }
  if (env.AUTH_APPLE_ID && env.AUTH_APPLE_SECRET) {
    configured.push(Apple({ clientId: env.AUTH_APPLE_ID, clientSecret: env.AUTH_APPLE_SECRET }));
  }

  return configured;
}

function authConfig(request: Request, env: Env): AuthConfig {
  const secure = new URL(request.url).protocol === "https:";
  return {
    adapter: D1Adapter(env.DB),
    basePath: "/auth",
    secret: env.AUTH_SECRET,
    trustHost: true,
    session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
    cookies: {
      sessionToken: {
        name: SESSION_COOKIE_NAME,
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure,
          ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
        },
      },
    },
    providers: providers(env),
    callbacks: {
      signIn({ account, profile }) {
        if (account?.provider === "google") return profile?.email_verified === true;
        return true;
      },
      jwt({ token, user }) {
        if (user?.id) token.sub = user.id;
        return token;
      },
      session({ session, token }) {
        if (session.user && token.sub) session.user.id = token.sub;
        return session;
      },
    },
  };
}

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  if (!env.AUTH_SECRET) return Response.json({ error: "Authentication is not configured" }, { status: 503 });
  return Auth(request, authConfig(request, env));
}

export async function authenticatedUser(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  if (!env.AUTH_SECRET) return null;
  const token = await getToken({ req: request, secret: env.AUTH_SECRET, cookieName: SESSION_COOKIE_NAME });
  if (!token?.sub || typeof token.email !== "string") return null;
  return { id: token.sub, email: token.email };
}

export async function register(request: Request, env: Env): Promise<Response> {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = Number(contentLengthHeader);
  if (!contentLengthHeader || !Number.isInteger(contentLength) || contentLength < 1) {
    return Response.json({ error: "A valid Content-Length header is required" }, { status: 411 });
  }
  if (contentLength > MAX_AUTH_BODY_BYTES) {
    return Response.json({ error: "Request body cannot exceed 8 KiB" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
  const password = typeof input.password === "string" ? input.password : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!validEmail(email)) return Response.json({ error: "A valid email is required" }, { status: 400 });
  if (password.length < 12 || password.length > 128) {
    return Response.json({ error: "Password must be between 12 and 128 characters" }, { status: 400 });
  }
  if (name.length > 100) return Response.json({ error: "Name cannot exceed 100 characters" }, { status: 400 });

  const id = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, name, email, "emailVerified", image) VALUES (?, ?, ?, NULL, NULL)`)
        .bind(id, name || null, email),
      env.DB.prepare(
        `INSERT INTO password_credentials
          (user_id, password_hash, password_salt, password_iterations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, bytesToBase64(hash), bytesToBase64(salt), PASSWORD_ITERATIONS, now, now),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("unique")) {
      return Response.json({ error: "An account with that email already exists" }, { status: 409 });
    }
    throw error;
  }
  return Response.json({ user: { id, email, name: name || null } }, { status: 201 });
}
