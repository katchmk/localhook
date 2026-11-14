import { Database } from "bun:sqlite";
import type {
  CapturedRequest,
  CapturedRequestSummary,
  Endpoint,
  HeaderPair,
  SentRequest,
} from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  response_status INTEGER NOT NULL DEFAULT 200,
  response_body TEXT NOT NULL DEFAULT '{"ok":true}',
  response_content_type TEXT NOT NULL DEFAULT 'application/json',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query TEXT NOT NULL,
  headers TEXT NOT NULL,
  body BLOB NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_endpoint_created ON requests(endpoint_id, created_at DESC);
CREATE TABLE IF NOT EXISTS sent (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  headers TEXT NOT NULL,
  body TEXT NOT NULL,
  body_encoding TEXT NOT NULL DEFAULT 'utf8',
  status INTEGER,
  response_headers TEXT NOT NULL,
  response_body TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
`;

type Row = Record<string, any>;

const toEndpoint = (r: Row): Endpoint => ({
  id: r.id,
  name: r.name,
  responseStatus: r.response_status,
  responseBody: r.response_body,
  responseContentType: r.response_content_type,
  createdAt: r.created_at,
  requestCount: r.request_count ?? 0,
});

const toSummary = (r: Row): CapturedRequestSummary => ({
  id: r.id,
  endpointId: r.endpoint_id,
  method: r.method,
  path: r.path,
  size: r.size,
  contentType: r.content_type,
  ip: r.ip,
  createdAt: r.created_at,
});

export function decodeBody(bytes: Uint8Array): Pick<CapturedRequest, "body" | "bodyEncoding"> {
  try {
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bodyEncoding: "utf8" };
  } catch {
    return { body: Buffer.from(bytes).toString("base64"), bodyEncoding: "base64" };
  }
}

const toSent = (r: Row): SentRequest => ({
  id: r.id,
  method: r.method,
  url: r.url,
  headers: JSON.parse(r.headers),
  body: r.body,
  bodyEncoding: r.body_encoding,
  status: r.status,
  responseHeaders: JSON.parse(r.response_headers),
  responseBody: r.response_body,
  durationMs: r.duration_ms,
  error: r.error,
  createdAt: r.created_at,
});

const ENDPOINT_SELECT = `
  SELECT e.*, (SELECT COUNT(*) FROM requests r WHERE r.endpoint_id = e.id) AS request_count
  FROM endpoints e`;

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // Databases created before binary sends lack this column.
  const sentColumns = db.query("PRAGMA table_info(sent)").all() as Row[];
  if (!sentColumns.some((c) => c.name === "body_encoding")) {
    db.exec("ALTER TABLE sent ADD COLUMN body_encoding TEXT NOT NULL DEFAULT 'utf8'");
  }

  return {
    close: () => db.close(),

    listEndpoints: (): Endpoint[] =>
      db.query(`${ENDPOINT_SELECT} ORDER BY e.created_at DESC`).all().map((r) => toEndpoint(r as Row)),

    getEndpoint: (id: string): Endpoint | null => {
      const r = db.query(`${ENDPOINT_SELECT} WHERE e.id = ?`).get(id) as Row | null;
      return r ? toEndpoint(r) : null;
    },

    createEndpoint: (id: string, name: string): Endpoint => {
      db.query("INSERT INTO endpoints (id, name, created_at) VALUES (?, ?, ?)").run(id, name, Date.now());
      return toEndpoint(db.query(`${ENDPOINT_SELECT} WHERE e.id = ?`).get(id) as Row);
    },

    updateEndpoint: (
      id: string,
      patch: Partial<Pick<Endpoint, "name" | "responseStatus" | "responseBody" | "responseContentType">>,
    ) => {
      db.query(
        `UPDATE endpoints SET
           name = COALESCE(?, name),
           response_status = COALESCE(?, response_status),
           response_body = COALESCE(?, response_body),
           response_content_type = COALESCE(?, response_content_type)
         WHERE id = ?`,
      ).run(
        patch.name ?? null,
        patch.responseStatus ?? null,
        patch.responseBody ?? null,
        patch.responseContentType ?? null,
        id,
      );
    },

    deleteEndpoint: (id: string) => {
      db.query("DELETE FROM endpoints WHERE id = ?").run(id);
    },

    insertRequest: (
      req: Omit<CapturedRequestSummary, "size"> & { query: string; headers: HeaderPair[]; body: Uint8Array },
      keep: number,
    ): CapturedRequestSummary => {
      db.query(
        `INSERT INTO requests (id, endpoint_id, method, path, query, headers, body, size, content_type, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        req.id,
        req.endpointId,
        req.method,
        req.path,
        req.query,
        JSON.stringify(req.headers),
        req.body,
        req.body.byteLength,
        req.contentType,
        req.ip,
        req.createdAt,
      );
      // Retention: keep only the newest `keep` requests for this endpoint.
      db.query(
        `DELETE FROM requests WHERE endpoint_id = ? AND id NOT IN (
           SELECT id FROM requests WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?)`,
      ).run(req.endpointId, req.endpointId, keep);
      const { body, headers, query, ...summary } = req;
      return { ...summary, size: body.byteLength };
    },

    listRequests: (endpointId: string): CapturedRequestSummary[] =>
      db
        .query(
          `SELECT id, endpoint_id, method, path, size, content_type, ip, created_at
           FROM requests WHERE endpoint_id = ? ORDER BY created_at DESC`,
        )
        .all(endpointId)
        .map((r) => toSummary(r as Row)),

    getRequest: (id: string): CapturedRequest | null => {
      const r = db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row | null;
      if (!r) return null;
      return {
        ...toSummary(r),
        query: r.query,
        headers: JSON.parse(r.headers),
        ...decodeBody(r.body),
      };
    },

    getRequestRaw: (id: string) =>
      db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row | null,

    exportRequests: (endpointId: string): CapturedRequest[] =>
      db
        .query("SELECT * FROM requests WHERE endpoint_id = ? ORDER BY created_at DESC")
        .all(endpointId)
        .map((r) => {
          const row = r as Row;
          return { ...toSummary(row), query: row.query, headers: JSON.parse(row.headers), ...decodeBody(row.body) };
        }),

    clearRequests: (endpointId: string) => {
      db.query("DELETE FROM requests WHERE endpoint_id = ?").run(endpointId);
    },

    deleteRequest: (id: string) => {
      db.query("DELETE FROM requests WHERE id = ?").run(id);
    },

    insertSent: (s: SentRequest, keep: number) => {
      db.query(
        `INSERT INTO sent (id, method, url, headers, body, body_encoding, status, response_headers, response_body, duration_ms, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id,
        s.method,
        s.url,
        JSON.stringify(s.headers),
        s.body,
        s.bodyEncoding,
        s.status,
        JSON.stringify(s.responseHeaders),
        s.responseBody,
        s.durationMs,
        s.error,
        s.createdAt,
      );
      db.query("DELETE FROM sent WHERE id NOT IN (SELECT id FROM sent ORDER BY created_at DESC LIMIT ?)").run(keep);
    },

    listSent: (): SentRequest[] =>
      db.query("SELECT * FROM sent ORDER BY created_at DESC").all().map((r) => toSent(r as Row)),

    clearSent: () => {
      db.query("DELETE FROM sent").run();
    },
  };
}
