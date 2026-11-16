import { Database } from "bun:sqlite";
import {
  DEFAULT_CUSTOM_SIGNATURE,
  type CapturedRequest,
  type CapturedRequestSummary,
  type Endpoint,
  type ForwardResult,
  type HeaderPair,
  type SavedRequest,
  type SavedRequestData,
  type SentRequest,
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
CREATE TABLE IF NOT EXISTS saved_requests (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  name TEXT NOT NULL,
  request TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first release. New and old databases both get them here.
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["sent", "body_encoding", "TEXT NOT NULL DEFAULT 'utf8'"],
  ["endpoints", "response_delay_ms", "INTEGER NOT NULL DEFAULT 0"],
  ["endpoints", "response_rules", "TEXT NOT NULL DEFAULT '[]'"],
  ["endpoints", "forward_url", "TEXT NOT NULL DEFAULT ''"],
  ["endpoints", "signature_scheme", "TEXT NOT NULL DEFAULT ''"],
  ["endpoints", "signature_secret", "TEXT NOT NULL DEFAULT ''"],
  ["endpoints", "signature_custom", `TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_CUSTOM_SIGNATURE)}'`],
  ["endpoints", "forward_mode", "TEXT NOT NULL DEFAULT 'async'"],
  ["requests", "forward", "TEXT"],
];

type Row = Record<string, any>;

const toEndpoint = (r: Row): Endpoint => ({
  id: r.id,
  name: r.name,
  responseStatus: r.response_status,
  responseBody: r.response_body,
  responseContentType: r.response_content_type,
  responseDelayMs: r.response_delay_ms,
  responseRules: JSON.parse(r.response_rules),
  forwardUrl: r.forward_url,
  forwardMode: r.forward_mode,
  signatureScheme: r.signature_scheme,
  signatureSecretSet: r.signature_secret !== "",
  // Saved before `payload` existed: fill in the defaults.
  signatureCustom: { ...DEFAULT_CUSTOM_SIGNATURE, ...JSON.parse(r.signature_custom) },
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
  forward: r.forward ? JSON.parse(r.forward) : null,
  createdAt: r.created_at,
});

const toRequest = (r: Row): Omit<CapturedRequest, "signature"> => ({
  ...toSummary(r),
  query: r.query,
  headers: JSON.parse(r.headers),
  ...decodeBody(r.body),
});

const SUMMARY_COLUMNS = "id, endpoint_id, method, path, size, content_type, ip, forward, created_at";

/** Columns that `updateEndpoint` can change, and how each is stored. */
const ENDPOINT_COLUMNS = {
  name: ["name", String],
  responseStatus: ["response_status", Number],
  responseBody: ["response_body", String],
  responseContentType: ["response_content_type", String],
  responseDelayMs: ["response_delay_ms", Number],
  responseRules: ["response_rules", JSON.stringify],
  forwardUrl: ["forward_url", String],
  forwardMode: ["forward_mode", String],
  signatureScheme: ["signature_scheme", String],
  signatureSecret: ["signature_secret", String],
  signatureCustom: ["signature_custom", JSON.stringify],
} as const satisfies Record<string, [string, (v: never) => string | number]>;

export type EndpointPatch = Partial<
  Pick<Endpoint, Exclude<keyof typeof ENDPOINT_COLUMNS, "signatureSecret">> & { signatureSecret: string }
>;

const toSaved = (r: Row): SavedRequest => ({
  id: r.id,
  collection: r.collection,
  name: r.name,
  request: JSON.parse(r.request),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface RequestFilter {
  method?: string;
  /** Case-insensitive text to find in the path, query, headers or body. */
  q?: string;
}

export type NewRequest = Omit<CapturedRequestSummary, "size" | "forward"> & {
  query: string;
  headers: HeaderPair[];
  body: Uint8Array;
};

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
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  const insertRequestQuery = db.query(
    `INSERT INTO requests (id, endpoint_id, method, path, query, headers, body, size, content_type, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Retention: keep only the newest `keep` requests for this endpoint.
  const pruneRequests = db.query(
    `DELETE FROM requests WHERE endpoint_id = ? AND id NOT IN (
       SELECT id FROM requests WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?)`,
  );
  const insertOne = (req: NewRequest) =>
    insertRequestQuery.run(
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

    updateEndpoint: (id: string, patch: EndpointPatch) => {
      const entries = Object.entries(ENDPOINT_COLUMNS).filter(([key]) => patch[key as keyof EndpointPatch] !== undefined);
      if (entries.length === 0) return;
      const sets = entries.map(([, [column]]) => `${column} = ?`).join(", ");
      const values = entries.map(([key, [, encode]]) => (encode as (v: unknown) => string | number)(patch[key as keyof EndpointPatch]));
      db.query(`UPDATE endpoints SET ${sets} WHERE id = ?`).run(...values, id);
    },

    /** Kept out of `Endpoint`, so the API never returns it by accident. */
    getSignatureSecret: (id: string): string | null =>
      (db.query("SELECT signature_secret FROM endpoints WHERE id = ?").get(id) as Row | null)?.signature_secret ?? null,

    deleteEndpoint: (id: string) => {
      db.query("DELETE FROM endpoints WHERE id = ?").run(id);
    },

    insertRequest: (req: NewRequest, keep: number): CapturedRequestSummary => {
      insertOne(req);
      pruneRequests.run(req.endpointId, req.endpointId, keep);
      const { body, headers, query, ...summary } = req;
      return { ...summary, size: body.byteLength, forward: null };
    },

    /** Inserts many requests in one transaction, e.g. from an import. */
    importRequests: db.transaction((reqs: NewRequest[], keep: number) => {
      for (const req of reqs) insertOne(req);
      for (const endpointId of new Set(reqs.map((r) => r.endpointId))) pruneRequests.run(endpointId, endpointId, keep);
    }),

    /** Saves the result of an auto-forward. Returns the new summary, or null if the request was deleted. */
    setForward: (id: string, forward: ForwardResult): CapturedRequestSummary | null => {
      db.query("UPDATE requests SET forward = ? WHERE id = ?").run(JSON.stringify(forward), id);
      const r = db.query(`SELECT ${SUMMARY_COLUMNS} FROM requests WHERE id = ?`).get(id) as Row | null;
      return r ? toSummary(r) : null;
    },

    listRequests: (endpointId: string, filter: RequestFilter = {}): CapturedRequestSummary[] => {
      const where = ["endpoint_id = ?"];
      const params: string[] = [endpointId];
      if (filter.method) {
        where.push("method = ?");
        params.push(filter.method.toUpperCase());
      }
      if (filter.q) {
        // instr() needs no escaping of % and _, unlike LIKE.
        where.push("instr(lower(path || ' ' || query || ' ' || headers || ' ' || CAST(body AS TEXT)), lower(?)) > 0");
        params.push(filter.q);
      }
      return db
        .query(`SELECT ${SUMMARY_COLUMNS} FROM requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC`)
        .all(...params)
        .map((r) => toSummary(r as Row));
    },

    getRequest: (id: string): Omit<CapturedRequest, "signature"> | null => {
      const r = db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row | null;
      return r ? toRequest(r) : null;
    },

    getRequestRaw: (id: string) =>
      db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row | null,

    exportRequests: (endpointId: string): Omit<CapturedRequest, "signature">[] =>
      db
        .query("SELECT * FROM requests WHERE endpoint_id = ? ORDER BY created_at DESC")
        .all(endpointId)
        .map((r) => toRequest(r as Row)),

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

    listSaved: (): SavedRequest[] =>
      db
        .query("SELECT * FROM saved_requests ORDER BY collection COLLATE NOCASE, name COLLATE NOCASE")
        .all()
        .map((r) => toSaved(r as Row)),

    getSaved: (id: string): SavedRequest | null => {
      const r = db.query("SELECT * FROM saved_requests WHERE id = ?").get(id) as Row | null;
      return r ? toSaved(r) : null;
    },

    createSaved: (collection: string, name: string, request: SavedRequestData): SavedRequest => {
      const id = crypto.randomUUID();
      const now = Date.now();
      db.query(
        "INSERT INTO saved_requests (id, collection, name, request, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, collection, name, JSON.stringify(request), now, now);
      return { id, collection, name, request, createdAt: now, updatedAt: now };
    },

    updateSaved: (id: string, patch: { collection?: string; name?: string; request?: SavedRequestData }) => {
      db.query(
        `UPDATE saved_requests SET
           collection = COALESCE(?, collection),
           name = COALESCE(?, name),
           request = COALESCE(?, request),
           updated_at = ?
         WHERE id = ?`,
      ).run(
        patch.collection ?? null,
        patch.name ?? null,
        patch.request ? JSON.stringify(patch.request) : null,
        Date.now(),
        id,
      );
    },

    deleteSaved: (id: string) => {
      db.query("DELETE FROM saved_requests WHERE id = ?").run(id);
    },

    /** Sender variables, used as {{name}}. Kept in order. */
    getVariables: (): HeaderPair[] => {
      const r = db.query("SELECT value FROM settings WHERE key = 'variables'").get() as Row | null;
      return r ? JSON.parse(r.value) : [];
    },

    setVariables: (variables: HeaderPair[]) => {
      db.query("INSERT INTO settings (key, value) VALUES ('variables', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        JSON.stringify(variables),
      );
    },
  };
}
