import { authenticatedUser, handleAuth, register } from "./auth";

type AssetRow = {
  id: string;
  object_key: string;
  filename: string;
  media_type: string;
  byte_size: number;
  etag: string;
  custom_metadata: string;
  status: "ready" | "deleting";
  created_at: string;
  updated_at: string;
  owner_id: string;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_METADATA_BYTES = 8 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", JSON_HEADERS["content-type"]);
  return Response.json(data, { ...init, headers });
}

function assetJson(row: AssetRow): Record<string, unknown> {
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    etag: row.etag,
    metadata: JSON.parse(row.custom_metadata) as unknown,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  if (new TextEncoder().encode(value).byteLength > MAX_METADATA_BYTES) {
    throw new HttpError(413, "Metadata cannot exceed 8 KiB");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Metadata must be a JSON object");
  }
}

function assetId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/assets\/([0-9a-f-]{36})(?:\/content)?$/i);
  return match?.[1] ?? null;
}

async function getAsset(env: Env, id: string, ownerId: string): Promise<AssetRow> {
  const row = await env.DB.prepare("SELECT * FROM assets WHERE id = ? AND owner_id = ?")
    .bind(id, ownerId)
    .first<AssetRow>();
  if (!row) throw new HttpError(404, "Asset not found");
  return row;
}

async function uploadAsset(request: Request, env: Env, ownerId: string): Promise<Response> {
  if (!request.body) throw new HttpError(400, "Request body is required");

  const rawFilename = request.headers.get("x-file-name")?.trim();
  if (!rawFilename || rawFilename.length > 512) {
    throw new HttpError(400, "X-File-Name is required and must be at most 512 characters");
  }

  const id = crypto.randomUUID();
  const objectKey = `users/${ownerId}/assets/${id}`;
  const mediaType = request.headers.get("content-type") || "application/octet-stream";
  const metadata = parseMetadata(request.headers.get("x-seriva-metadata"));
  const uploaded = await env.ASSETS.put(objectKey, request.body, {
    httpMetadata: { contentType: mediaType },
    customMetadata: { assetId: id },
  });

  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO assets
        (id, object_key, filename, media_type, byte_size, etag, custom_metadata, status, created_at, updated_at, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
    )
      .bind(id, objectKey, rawFilename, mediaType, uploaded.size, uploaded.httpEtag, JSON.stringify(metadata), now, now, ownerId)
      .run();
  } catch (error) {
    await env.ASSETS.delete(objectKey);
    throw error;
  }

  const row = await getAsset(env, id, ownerId);
  return json({ asset: assetJson(row) }, { status: 201, headers: { location: `/v1/assets/${id}` } });
}

async function listAssets(url: URL, env: Env, ownerId: string): Promise<Response> {
  const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    throw new HttpError(400, "limit must be an integer between 1 and 100");
  }
  const cursor = url.searchParams.get("cursor");
  let query = "SELECT * FROM assets WHERE status = 'ready' AND owner_id = ?";
  const bindings: Array<string | number> = [ownerId];
  if (cursor) {
    const separator = cursor.indexOf("|");
    if (separator < 1) throw new HttpError(400, "Invalid cursor");
    query += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    const createdAt = cursor.slice(0, separator);
    const id = cursor.slice(separator + 1);
    bindings.push(createdAt, createdAt, id);
  }
  query += " ORDER BY created_at DESC, id DESC LIMIT ?";
  bindings.push(requestedLimit + 1);

  const result = await env.DB.prepare(query).bind(...bindings).all<AssetRow>();
  const rows = result.results.slice(0, requestedLimit);
  const last = rows.at(-1);
  return json({
    assets: rows.map(assetJson),
    nextCursor: result.results.length > requestedLimit && last ? `${last.created_at}|${last.id}` : null,
  });
}

async function downloadAsset(env: Env, id: string, request: Request, ownerId: string): Promise<Response> {
  const row = await getAsset(env, id, ownerId);
  if (row.status !== "ready") throw new HttpError(409, "Asset is not available");
  const object = await env.ASSETS.get(row.object_key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (!object) throw new HttpError(404, "Asset content not found");

  if (!("body" in object)) {
    return new Response(null, { status: 304, headers: { etag: object.httpEtag } });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
  if (request.headers.has("range") && "range" in object) {
    const range = object.range;
    if (typeof range === "object" && "offset" in range && "length" in range) {
      const { offset, length } = range;
      if (typeof offset === "number" && typeof length === "number") {
        headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${row.byte_size}`);
        headers.set("content-length", String(length));
        return new Response(object.body, { status: 206, headers });
      }
    }
  }
  headers.set("content-length", String(row.byte_size));
  return new Response(object.body, { headers });
}

async function updateAsset(request: Request, env: Env, id: string, ownerId: string): Promise<Response> {
  await getAsset(env, id, ownerId);
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = Number(contentLengthHeader);
  if (!contentLengthHeader || !Number.isInteger(contentLength) || contentLength < 1) {
    throw new HttpError(411, "A valid Content-Length header is required");
  }
  if (contentLength > MAX_METADATA_BYTES) throw new HttpError(413, "Request body cannot exceed 8 KiB");
  const body: unknown = await request.json();
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const input = body as Record<string, unknown>;
  if (typeof input.filename !== "string" || !input.filename.trim() || input.filename.length > 512) {
    throw new HttpError(400, "filename is required and must be at most 512 characters");
  }
  const metadata = input.metadata ?? {};
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new HttpError(400, "metadata must be a JSON object");
  }
  const metadataJson = JSON.stringify(metadata);
  if (new TextEncoder().encode(metadataJson).byteLength > MAX_METADATA_BYTES) {
    throw new HttpError(413, "Metadata cannot exceed 8 KiB");
  }
  await env.DB.prepare("UPDATE assets SET filename = ?, custom_metadata = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(input.filename.trim(), metadataJson, new Date().toISOString(), id, ownerId)
    .run();
  return json({ asset: assetJson(await getAsset(env, id, ownerId)) });
}

async function deleteAsset(env: Env, id: string, ownerId: string): Promise<Response> {
  const row = await getAsset(env, id, ownerId);
  await env.DB.prepare("UPDATE assets SET status = 'deleting', updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(new Date().toISOString(), id, ownerId)
    .run();
  await env.ASSETS.delete(row.object_key);
  await env.DB.prepare("DELETE FROM assets WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
  return new Response(null, { status: 204 });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok" });
  }
  if (url.pathname.startsWith("/auth/")) return handleAuth(request, env);
  if (url.pathname === "/v1/auth/register" && request.method === "POST") return register(request, env);

  const user = await authenticatedUser(request, env);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  if (url.pathname === "/v1/auth/me" && request.method === "GET") return json({ user });
  if (url.pathname === "/v1/assets" && request.method === "POST") return uploadAsset(request, env, user.id);
  if (url.pathname === "/v1/assets" && request.method === "GET") return listAssets(url, env, user.id);

  const id = assetId(url.pathname);
  if (id && url.pathname.endsWith("/content") && request.method === "GET") return downloadAsset(env, id, request, user.id);
  if (id && !url.pathname.endsWith("/content") && request.method === "GET") {
    return json({ asset: assetJson(await getAsset(env, id, user.id)) });
  }
  if (id && !url.pathname.endsWith("/content") && request.method === "PATCH") return updateAsset(request, env, id, user.id);
  if (id && !url.pathname.endsWith("/content") && request.method === "DELETE") return deleteAsset(env, id, user.id);
  return json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, { status: error.status });
      console.error(JSON.stringify({
        message: "Unhandled request error",
        error: error instanceof Error ? error.message : String(error),
        path: new URL(request.url).pathname,
      }));
      return json({ error: "Internal server error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
