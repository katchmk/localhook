import { Hono, type Context } from "hono";
import { getConnInfo, serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Store } from "./db";
import type { Hub } from "./hub";
import { sendRequest } from "./send";
import type { HeaderPair, SendInput } from "./types";

export interface Config {
  maxBodyBytes: number;
  maxRequestsPerEndpoint: number;
  maxSent: number;
  sendTimeoutMs: number;
  /** Directory with the built web UI. Omit to serve only the API (dev mode). */
  staticDir?: string;
}

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

export function createApp(store: Store, hub: Hub, config: Config) {
  const app = new Hono();

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
    const headers: HeaderPair[] = [...c.req.raw.headers.entries()];
    const summary = store.insertRequest(
      {
        id: crypto.randomUUID(),
        endpointId: id,
        method: c.req.method,
        path: url.pathname.slice(prefix.length) || "/",
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

    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "*");
    c.header("Access-Control-Allow-Headers", "*");
    c.header("Content-Type", endpoint.responseContentType);
    const status = endpoint.responseStatus as ContentfulStatusCode;
    return c.req.method === "HEAD" ? c.body(null, status) : c.body(endpoint.responseBody, status);
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
    const patch = await c.req.json();
    if (patch.responseStatus !== undefined) {
      const s = Number(patch.responseStatus);
      if (!Number.isInteger(s) || s < 200 || s > 599) return c.json({ error: "Status must be 200-599" }, 400);
      patch.responseStatus = s;
    }
    store.updateEndpoint(id, patch);
    return c.json(store.getEndpoint(id));
  });

  api.delete("/endpoints/:id", (c) => {
    store.deleteEndpoint(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- Captured requests ----
  api.get("/endpoints/:id/requests", (c) => c.json(store.listRequests(c.req.param("id"))));

  api.delete("/endpoints/:id/requests", (c) => {
    store.clearRequests(c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/endpoints/:id/export", (c) => {
    const id = c.req.param("id");
    c.header("Content-Disposition", `attachment; filename="localhook-${id}.json"`);
    return c.json(store.exportRequests(id));
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
    const req = store.getRequest(c.req.param("id"));
    return req ? c.json(req) : c.json({ error: "Not found" }, 404);
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
    const sent = await sendRequest(
      {
        method: input.method || "GET",
        url: input.url,
        headers: input.headers ?? [],
        body:
          input.bodyEncoding === "base64"
            ? new Uint8Array(Buffer.from(input.body ?? "", "base64"))
            : (input.body ?? ""),
      },
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

  app.route("/api", api);

  // ---- Web UI (production build) ----
  if (config.staticDir) {
    const root = config.staticDir;
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ path: `${root}/index.html` }));
  }

  return app;
}
