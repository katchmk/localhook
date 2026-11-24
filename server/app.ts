import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getConnInfo, serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { EndpointPatch, Store } from "./db";
import type { Hub } from "./hub";
import { sendRaw, sendRequest } from "./send";
import { checkSignature, signRequest } from "./signature";
import { parseImport, toHar } from "./transfer";
import type { TunnelManager } from "./tunnel";
import {
  DEFAULT_CUSTOM_SIGNATURE,
  DOMAIN_PROVIDER,
  FORWARD_MODES,
  SIGNATURE_ALGORITHMS,
  SIGNATURE_SCHEMES,
  type CustomSignature,
  type Endpoint,
  type HeaderPair,
  type OutgoingSignature,
  type ResponseRule,
  type SavedRequestData,
  type SendInput,
  type SenderAuth,
  type SignatureScheme,
  type TunnelInfo,
} from "./types";

export interface Config {
  maxBodyBytes: number;
  maxRequestsPerEndpoint: number;
  maxSent: number;
  sendTimeoutMs: number;
  /** Directory with the built web UI. Omit to serve only the API (dev mode). */
  staticDir?: string;
  /** HTTP Basic auth for the UI and API. Webhook URLs stay open. Omit to disable. */
  auth?: { username: string; password: string };
  /** Starts and stops the tunnel that gives the receiver a public URL. Omit to turn tunnels off. */
  tunnel?: TunnelManager;
}

const MAX_DELAY_MS = 60_000;

// Each forward adds 1 to this header. Endpoints that forward to each other stop after MAX_HOPS.
const HOPS_HEADER = "x-localhook-hops";
const MAX_HOPS = 5;

const HOSTNAME_PATTERN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Cloudflare tunnel tokens are base64 text.
const TOKEN_PATTERN = /^[A-Za-z0-9+/_=-]{20,2000}$/;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function randomId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function clientIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // No socket info, e.g. app.request() in tests.
  }
}

const EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/xml": "xml",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** Uses the filename from a Content-Disposition request header, else one built from the id and content type. */
function bodyFileName(id: string, contentType: string | null, headers: HeaderPair[]): string {
  const disposition = headers.find(([k]) => k.toLowerCase() === "content-disposition")?.[1];
  const named = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  // Keep it safe inside the quoted header value and as a file name.
  const safe = named?.replace(/[^\w.\- ]/g, "_").trim();
  if (safe) return safe;
  const ext = EXTENSIONS[contentType?.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "bin";
  return `request-${id.slice(0, 8)}.${ext}`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a rule path, where `*` matches any characters. */
function pathMatches(pattern: string, path: string) {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(path);
}

const matchRule = (endpoint: Endpoint, method: string, path: string) =>
  endpoint.responseRules.find((r) => (!r.method || r.method === method) && (!r.path || pathMatches(r.path, path)));

// Response headers of a proxied response that describe the connection to the forward target.
// fetch() also decompresses the body, so the encoding and length no longer apply.
const PROXY_SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

const isPairs = (v: unknown): v is HeaderPair[] =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "string"));

/** Validates custom signature settings. Returns them, or an error message for the user. */
function parseCustomSignature(input: unknown): CustomSignature | string {
  const c = { ...DEFAULT_CUSTOM_SIGNATURE, ...(input as Partial<CustomSignature> | null) };
  const header = String(c.header).trim();
  // RFC 9110 token characters.
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) return "Signature header must be a valid header name";
  if (!SIGNATURE_ALGORITHMS.includes(c.algorithm)) {
    return `Signature algorithm must be one of: ${SIGNATURE_ALGORITHMS.join(", ")}`;
  }
  if (c.encoding !== "hex" && c.encoding !== "base64") return "Signature encoding must be hex or base64";
  if (typeof c.payload !== "string" || !c.payload) return "Signature payload must not be empty";
  return { header, algorithm: c.algorithm, encoding: c.encoding, payload: c.payload };
}

/** Validates the signature settings of an outgoing request. */
function parseOutgoingSignature(input: unknown): OutgoingSignature | null | string {
  if (input === undefined || input === null) return null;
  const s = input as Partial<OutgoingSignature>;
  if (!SIGNATURE_SCHEMES.includes(s.scheme as SignatureScheme)) {
    return `Signature scheme must be one of: ${SIGNATURE_SCHEMES.join(", ")}`;
  }
  if (typeof s.secret !== "string") return "Signature secret must be a string";
  const custom = parseCustomSignature(s.custom);
  if (typeof custom === "string") return custom;
  return { scheme: s.scheme!, secret: s.secret, custom };
}

const AUTH_TYPES: SenderAuth["type"][] = ["none", "basic", "bearer", "apikey"];

/** Validates a saved Sender request and fills in defaults. */
function parseSavedData(input: unknown): SavedRequestData | string {
  const r = (input ?? {}) as Partial<SavedRequestData>;
  if (typeof r.method !== "string" || typeof r.url !== "string") return "A saved request needs a method and url";
  if (r.headers !== undefined && !isPairs(r.headers)) return "Headers must be [name, value] pairs";
  const a = (r.auth ?? {}) as Partial<SenderAuth>;
  const sign = parseOutgoingSignature(r.sign);
  if (typeof sign === "string") return sign;
  return {
    method: r.method.toUpperCase(),
    url: r.url,
    headers: r.headers ?? [],
    body: typeof r.body === "string" ? r.body : "",
    bodyEncoding: r.bodyEncoding === "base64" ? "base64" : "utf8",
    fileName: typeof r.fileName === "string" ? r.fileName : null,
    auth: {
      type: AUTH_TYPES.includes(a.type!) ? a.type! : "none",
      username: String(a.username ?? ""),
      password: String(a.password ?? ""),
      token: String(a.token ?? ""),
      key: String(a.key ?? ""),
      value: String(a.value ?? ""),
      in: a.in === "query" ? "query" : "header",
    },
    sign,
  };
}

/** The forward URL plus the captured subpath and query, e.g. http://app/webhooks + /orders?x=1. */
function forwardTarget(base: string, path: string, query: string) {
  const url = new URL(base);
  if (path !== "/") url.pathname = url.pathname.replace(/\/+$/, "") + path;
  for (const [k, v] of new URLSearchParams(query)) url.searchParams.append(k, v);
  return url.toString();
}

const isStatus = (v: unknown) => Number.isInteger(v) && (v as number) >= 200 && (v as number) <= 599;
const isDelay = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_DELAY_MS;

/** Validates a PATCH body. Returns the patch, or an error message for the user. */
function parsePatch(input: Record<string, unknown>): EndpointPatch | string {
  const patch: EndpointPatch = {};
  for (const key of ["name", "responseBody", "responseContentType", "signatureSecret"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string") return `${key} must be a string`;
    patch[key] = input[key];
  }
  if (input.responseStatus !== undefined) {
    const s = Number(input.responseStatus);
    if (!isStatus(s)) return "Status must be 200-599";
    patch.responseStatus = s;
  }
  if (input.responseDelayMs !== undefined) {
    const d = Number(input.responseDelayMs);
    if (!isDelay(d)) return `Delay must be 0-${MAX_DELAY_MS} ms`;
    patch.responseDelayMs = d;
  }
  if (input.forwardUrl !== undefined) {
    const url = String(input.forwardUrl).trim();
    if (url && !/^https?:$/.test(URL.parse(url)?.protocol ?? "")) return "Forward URL must be an http or https URL";
    patch.forwardUrl = url;
  }
  if (input.signatureScheme !== undefined) {
    const scheme = input.signatureScheme;
    if (scheme !== "" && !SIGNATURE_SCHEMES.includes(scheme as never)) {
      return `Signature scheme must be one of: ${SIGNATURE_SCHEMES.join(", ")}`;
    }
    patch.signatureScheme = scheme as EndpointPatch["signatureScheme"];
  }
  if (input.signatureCustom !== undefined) {
    const custom = parseCustomSignature(input.signatureCustom);
    if (typeof custom === "string") return custom;
    patch.signatureCustom = custom;
  }
  if (input.forwardMode !== undefined) {
    if (!FORWARD_MODES.includes(input.forwardMode as never)) return `Forward mode must be one of: ${FORWARD_MODES.join(", ")}`;
    patch.forwardMode = input.forwardMode as Endpoint["forwardMode"];
  }
  if (input.responseRules !== undefined) {
    if (!Array.isArray(input.responseRules)) return "responseRules must be an array";
    const rules: ResponseRule[] = [];
    for (const [i, r] of (input.responseRules as Partial<ResponseRule>[]).entries()) {
      const rule = {
        method: String(r?.method ?? "").trim().toUpperCase(),
        path: String(r?.path ?? "").trim(),
        status: Number(r?.status ?? 200),
        contentType: String(r?.contentType ?? "application/json"),
        body: String(r?.body ?? ""),
        delayMs: Number(r?.delayMs ?? 0),
      };
      if (!isStatus(rule.status)) return `Rule ${i + 1}: status must be 200-599`;
      if (!isDelay(rule.delayMs)) return `Rule ${i + 1}: delay must be 0-${MAX_DELAY_MS} ms`;
      rules.push(rule);
    }
    patch.responseRules = rules;
  }
  return patch;
}

export function createApp(store: Store, hub: Hub, config: Config) {
  const app = new Hono();

  if (config.auth) {
    // Webhook senders cannot log in, so /hook stays open.
    const auth = basicAuth(config.auth);
    app.use("*", (c, next) => (c.req.path === "/hook" || c.req.path.startsWith("/hook/") ? next() : auth(c, next)));
  }

  // Sends a captured request to the endpoint's forward URL and saves the result on it.
  const forward = async (
    requestId: string,
    base: string,
    req: { method: string; path: string; query: string; headers: HeaderPair[]; body: Uint8Array<ArrayBuffer> },
  ) => {
    const url = forwardTarget(base, req.path, req.query);
    const result = await sendRaw({ ...req, url }, config.sendTimeoutMs, config.maxBodyBytes);
    const { sent } = result;
    const summary = store.setForward(requestId, {
      url,
      status: sent.status,
      error: sent.error,
      durationMs: sent.durationMs,
    });
    if (summary) hub.publish(summary);
    return result;
  };

  // ---- Webhook receiver: any method, any subpath ----
  const capture = async (c: Context) => {
    const id = c.req.param("id")!;
    const endpoint = store.getEndpoint(id);
    if (!endpoint) return c.json({ error: `Unknown endpoint "${id}"` }, 404);

    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > config.maxBodyBytes) return c.json({ error: "Payload too large" }, 413);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > config.maxBodyBytes) return c.json({ error: "Payload too large" }, 413);

    const url = new URL(c.req.url);
    const prefix = `/hook/${id}`;
    const path = url.pathname.slice(prefix.length) || "/";
    const headers: HeaderPair[] = [...c.req.raw.headers.entries()];
    const summary = store.insertRequest(
      {
        id: crypto.randomUUID(),
        endpointId: id,
        method: c.req.method,
        path,
        query: url.search,
        headers,
        body,
        contentType: c.req.header("content-type") ?? null,
        ip: clientIp(c),
        createdAt: Date.now(),
      },
      config.maxRequestsPerEndpoint,
    );
    hub.publish(summary);

    const rule = matchRule(endpoint, c.req.method, path);
    const hops = Number(c.req.header(HOPS_HEADER)) || 0;
    const forwardReq = {
      method: c.req.method,
      path,
      query: url.search,
      headers: [...headers.filter(([k]) => k !== HOPS_HEADER), [HOPS_HEADER, String(hops + 1)] as HeaderPair],
      body,
    };
    const forwardUrl = hops < MAX_HOPS ? endpoint.forwardUrl : "";
    const cors: HeaderPair[] = [
      ["Access-Control-Allow-Origin", "*"],
      ["Access-Control-Allow-Methods", "*"],
      ["Access-Control-Allow-Headers", "*"],
    ];

    // Proxy mode: wait for the forward target and return its response. A matching rule still wins.
    if (forwardUrl && endpoint.forwardMode === "proxy" && !rule) {
      const { sent, bytes } = await forward(summary.id, forwardUrl, forwardReq);
      if (endpoint.responseDelayMs > 0) await Bun.sleep(endpoint.responseDelayMs);
      if (sent.status === null) return c.json({ error: `Forward failed: ${sent.error}` }, 502);
      const res = new Headers(cors);
      for (const [k, v] of sent.responseHeaders) {
        // The target's headers replace the CORS defaults; Set-Cookie can repeat.
        if (k.toLowerCase() === "set-cookie") res.append(k, v);
        else if (!PROXY_SKIP.has(k.toLowerCase())) res.set(k, v);
      }
      const noBody = c.req.method === "HEAD" || [204, 205, 304].includes(sent.status);
      return new Response(noBody ? null : bytes, { status: sent.status, headers: res });
    }

    // Do not wait: the sender gets the configured response, not the forward target's response.
    if (forwardUrl) void forward(summary.id, forwardUrl, forwardReq);

    const response = rule ?? {
      status: endpoint.responseStatus,
      contentType: endpoint.responseContentType,
      body: endpoint.responseBody,
      delayMs: endpoint.responseDelayMs,
    };
    if (response.delayMs > 0) await Bun.sleep(response.delayMs);
    for (const [k, v] of cors) c.header(k, v);
    c.header("Content-Type", response.contentType);
    const status = response.status as ContentfulStatusCode;
    return c.req.method === "HEAD" ? c.body(null, status) : c.body(response.body, status);
  };
  app.all("/hook/:id", capture);
  app.all("/hook/:id/*", capture);

  // ---- Endpoints ----
  const api = new Hono();

  api.get("/endpoints", (c) => c.json(store.listEndpoints()));

  api.post("/endpoints", async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { id?: string; name?: string };
    const id = input.id?.trim() || randomId();
    if (!ID_PATTERN.test(id)) return c.json({ error: "Id may contain only letters, digits, - and _" }, 400);
    if (store.getEndpoint(id)) return c.json({ error: `Endpoint "${id}" already exists` }, 409);
    return c.json(store.createEndpoint(id, input.name?.trim() || id), 201);
  });

  api.get("/endpoints/:id", (c) => {
    const endpoint = store.getEndpoint(c.req.param("id"));
    return endpoint ? c.json(endpoint) : c.json({ error: "Not found" }, 404);
  });

  api.patch("/endpoints/:id", async (c) => {
    const id = c.req.param("id");
    if (!store.getEndpoint(id)) return c.json({ error: "Not found" }, 404);
    const patch = parsePatch(await c.req.json().catch(() => ({})));
    if (typeof patch === "string") return c.json({ error: patch }, 400);
    store.updateEndpoint(id, patch);
    return c.json(store.getEndpoint(id));
  });

  // The secret is left out of the endpoint, so it shows only when the user asks for it.
  api.get("/endpoints/:id/secret", (c) => {
    const secret = store.getSignatureSecret(c.req.param("id"));
    return secret === null ? c.json({ error: "Not found" }, 404) : c.json({ signatureSecret: secret });
  });

  api.delete("/endpoints/:id", (c) => {
    store.deleteEndpoint(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- Captured requests ----
  api.get("/endpoints/:id/requests", (c) =>
    c.json(store.listRequests(c.req.param("id"), { method: c.req.query("method"), q: c.req.query("q") })),
  );

  api.delete("/endpoints/:id/requests", (c) => {
    store.clearRequests(c.req.param("id"));
    return c.body(null, 204);
  });

  // ?format=har for HAR 1.2, else a JSON array that /import reads back.
  api.get("/endpoints/:id/export", (c) => {
    const id = c.req.param("id");
    const endpoint = store.getEndpoint(id);
    if (!endpoint) return c.json({ error: "Not found" }, 404);
    const requests = store.exportRequests(id);
    if (c.req.query("format") === "har") {
      c.header("Content-Disposition", `attachment; filename="localhook-${id}.har"`);
      return c.json(toHar(endpoint, requests, `${new URL(c.req.url).origin}/hook/${id}`));
    }
    c.header("Content-Disposition", `attachment; filename="localhook-${id}.json"`);
    return c.json(requests);
  });

  // Accepts a localhook JSON export or a HAR file. Imported requests get new ids.
  api.post("/endpoints/:id/import", async (c) => {
    const id = c.req.param("id");
    if (!store.getEndpoint(id)) return c.json({ error: "Not found" }, 404);
    const data = await c.req.json().catch(() => undefined);
    if (data === undefined) return c.json({ error: "The file is not valid JSON" }, 400);
    let requests;
    try {
      requests = parseImport(data, id);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    store.importRequests(requests, config.maxRequestsPerEndpoint);
    return c.json({ imported: Math.min(requests.length, config.maxRequestsPerEndpoint) });
  });

  api.get("/endpoints/:id/stream", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const unsubscribe = hub.subscribe(id, (req) => {
        void stream.writeSSE({ event: "request", data: JSON.stringify(req) });
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: "ready", data: "" });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: "ping", data: "" });
      }
    });
  });

  api.get("/requests/:id", (c) => {
    const row = store.getRequestRaw(c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const req = store.getRequest(row.id)!;
    const endpoint = store.getEndpoint(req.endpointId);
    const signature = endpoint?.signatureScheme
      ? checkSignature(
          endpoint.signatureScheme,
          store.getSignatureSecret(endpoint.id) ?? "",
          req.headers,
          new Uint8Array(row.body),
          endpoint.signatureCustom,
        )
      : null;
    return c.json({ ...req, signature });
  });

  // Download the raw body bytes, e.g. for binary bodies the UI does not show.
  api.get("/requests/:id/body", (c) => {
    const row = store.getRequestRaw(c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const headers: HeaderPair[] = JSON.parse(row.headers);
    return c.body(new Uint8Array(row.body), 200, {
      "content-type": row.content_type || "application/octet-stream",
      "content-disposition": `attachment; filename="${bodyFileName(row.id, row.content_type, headers)}"`,
    });
  });

  api.delete("/requests/:id", (c) => {
    store.deleteRequest(c.req.param("id"));
    return c.body(null, 204);
  });

  // Re-send a captured request, with its original method, headers and raw body bytes, to another URL.
  api.post("/requests/:id/replay", async (c) => {
    const row = store.getRequestRaw(c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const { url } = (await c.req.json()) as { url?: string };
    if (!url || !URL.canParse(url)) return c.json({ error: "A valid url is required" }, 400);
    const sent = await sendRequest(
      { method: row.method, url, headers: JSON.parse(row.headers), body: new Uint8Array(row.body) },
      config.sendTimeoutMs,
      config.maxBodyBytes,
    );
    store.insertSent(sent, config.maxSent);
    return c.json(sent);
  });

  // ---- Sender ----
  api.post("/send", async (c) => {
    const input = (await c.req.json()) as Partial<SendInput>;
    if (!input.url || !URL.canParse(input.url)) return c.json({ error: "A valid url is required" }, 400);
    const sign = parseOutgoingSignature(input.sign);
    if (typeof sign === "string") return c.json({ error: sign }, 400);
    const body =
      input.bodyEncoding === "base64"
        ? new Uint8Array(Buffer.from(input.body ?? "", "base64"))
        : (input.body ?? "");
    let headers = input.headers ?? [];
    if (sign) {
      const signed = signRequest(sign, headers, typeof body === "string" ? new TextEncoder().encode(body) : body);
      if (typeof signed === "string") return c.json({ error: signed }, 400);
      headers = signed;
    }
    const sent = await sendRequest(
      { method: input.method || "GET", url: input.url, headers, body },
      config.sendTimeoutMs,
      config.maxBodyBytes,
    );
    store.insertSent(sent, config.maxSent);
    return c.json(sent);
  });

  api.get("/sent", (c) => c.json(store.listSent()));

  api.delete("/sent", (c) => {
    store.clearSent();
    return c.body(null, 204);
  });

  // ---- Saved Sender requests and variables ----
  api.get("/saved", (c) => c.json(store.listSaved()));

  api.post("/saved", async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { collection?: string; name?: string; request?: unknown };
    const name = input.name?.trim();
    if (!name) return c.json({ error: "A name is required" }, 400);
    const request = parseSavedData(input.request);
    if (typeof request === "string") return c.json({ error: request }, 400);
    return c.json(store.createSaved(input.collection?.trim() || "Default", name, request), 201);
  });

  api.put("/saved/:id", async (c) => {
    const id = c.req.param("id");
    if (!store.getSaved(id)) return c.json({ error: "Not found" }, 404);
    const input = (await c.req.json().catch(() => ({}))) as { collection?: string; name?: string; request?: unknown };
    let request: SavedRequestData | undefined;
    if (input.request !== undefined) {
      const parsed = parseSavedData(input.request);
      if (typeof parsed === "string") return c.json({ error: parsed }, 400);
      request = parsed;
    }
    if (input.name !== undefined && !input.name.trim()) return c.json({ error: "A name is required" }, 400);
    store.updateSaved(id, { collection: input.collection?.trim() || undefined, name: input.name?.trim(), request });
    return c.json(store.getSaved(id));
  });

  api.delete("/saved/:id", (c) => {
    store.deleteSaved(c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/variables", (c) => c.json(store.getVariables()));

  api.put("/variables", async (c) => {
    const input = await c.req.json().catch(() => null);
    if (!isPairs(input)) return c.json({ error: "Variables must be [name, value] pairs" }, 400);
    store.setVariables(input.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    return c.json(store.getVariables());
  });

  const tunnelInfo = (): TunnelInfo => ({
    state: config.tunnel?.state() ?? null,
    providers: config.tunnel?.providers() ?? [],
    proxyPort: config.tunnel?.port ?? 0,
    domain: { hostname: store.getTunnelDomain()?.hostname ?? "", tokenSet: !!store.getTunnelDomain() },
  });
  api.get("/tunnel", (c) => c.json(tunnelInfo()));

  // Body: { provider: "ngrok" } to start (or switch), { provider: "" } to stop. The choice is kept for the next boot.
  api.put("/tunnel", async (c) => {
    const input = await c.req.json().catch(() => null);
    const provider = typeof input?.provider === "string" ? input.provider : null;
    if (!config.tunnel || provider === null) return c.json({ error: "provider must be a string" }, 400);
    if (provider === "") config.tunnel.stop();
    else if (!config.tunnel.start(provider)) return c.json({ error: `Unknown tunnel provider "${provider}"` }, 400);
    store.setTunnelProvider(provider);
    return c.json(tunnelInfo());
  });

  // Body: { hostname, token? }. An empty hostname removes the settings. A missing token keeps the saved one.
  api.put("/tunnel/domain", async (c) => {
    const input = await c.req.json().catch(() => null);
    if (!config.tunnel || typeof input?.hostname !== "string") return c.json({ error: "hostname must be a string" }, 400);
    const stopIfRunning = () => {
      if (config.tunnel!.state()?.provider === DOMAIN_PROVIDER) config.tunnel!.stop();
    };
    const hostname = input.hostname.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
    if (!hostname) {
      stopIfRunning();
      store.setTunnelDomain(null);
      if (store.getTunnelProvider() === DOMAIN_PROVIDER) store.setTunnelProvider("");
      return c.json(tunnelInfo());
    }
    if (!HOSTNAME_PATTERN.test(hostname)) return c.json({ error: "Enter a hostname such as hook.example.com" }, 400);
    const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : store.getTunnelDomain()?.token;
    if (!token || !TOKEN_PATTERN.test(token)) return c.json({ error: "Enter the tunnel token from Cloudflare" }, 400);
    store.setTunnelDomain({ hostname, token });
    if (config.tunnel.state()?.provider === DOMAIN_PROVIDER) config.tunnel.start(DOMAIN_PROVIDER); // Use the new settings.
    return c.json(tunnelInfo());
  });

  app.route("/api", api);

  // ---- Web UI (production build) ----
  if (config.staticDir) {
    const root = config.staticDir;
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ path: `${root}/index.html` }));
  }

  return app;
}
