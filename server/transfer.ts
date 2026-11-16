import type { NewRequest } from "./db";
import type { CapturedRequest, Endpoint, HeaderPair } from "./types";

type Exported = Omit<CapturedRequest, "signature">;

/** HAR 1.2 (http://www.softwareishard.com/blog/har-12-spec/). The response is the endpoint's default response. */
export function toHar(endpoint: Endpoint, requests: Exported[], hookUrl: string) {
  const pairs = (headers: HeaderPair[]) => headers.map(([name, value]) => ({ name, value }));
  return {
    log: {
      version: "1.2",
      creator: { name: "localhook", version: "1" },
      entries: requests.map((r) => ({
        startedDateTime: new Date(r.createdAt).toISOString(),
        time: 0,
        request: {
          method: r.method,
          url: `${hookUrl}${r.path === "/" ? "" : r.path}${r.query}`,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: pairs(r.headers),
          queryString: pairs([...new URLSearchParams(r.query).entries()]),
          ...(r.size > 0 && {
            postData: {
              mimeType: r.contentType ?? "",
              text: r.body,
              // Not in HAR 1.2 for requests, but the same field as response content uses.
              ...(r.bodyEncoding === "base64" && { encoding: "base64" }),
            },
          }),
          headersSize: -1,
          bodySize: r.size,
        },
        response: {
          status: endpoint.responseStatus,
          statusText: "",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [{ name: "Content-Type", value: endpoint.responseContentType }],
          content: {
            size: Buffer.byteLength(endpoint.responseBody),
            mimeType: endpoint.responseContentType,
            text: endpoint.responseBody,
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  };
}

const header = (headers: HeaderPair[], name: string) => headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;

const decode = (text: unknown, encoding: unknown) =>
  new Uint8Array(Buffer.from(typeof text === "string" ? text : "", encoding === "base64" ? "base64" : "utf8"));

const isPairs = (v: unknown): v is HeaderPair[] =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string");

/**
 * Reads a localhook JSON export (an array of requests) or a HAR file into requests for `endpointId`.
 * Each request gets a new id. Throws with a message for the user when the file is not valid.
 */
export function parseImport(data: unknown, endpointId: string): NewRequest[] {
  const entries = (data as { log?: { entries?: unknown } } | null)?.log?.entries;
  if (Array.isArray(entries)) return entries.map((e, i) => fromHarEntry(e, endpointId, i));
  if (Array.isArray(data)) return data.map((r, i) => fromExported(r, endpointId, i));
  throw new Error("Expected a localhook JSON export or a HAR file");
}

function fromExported(r: Partial<Exported>, endpointId: string, i: number): NewRequest {
  if (typeof r?.method !== "string" || typeof r.path !== "string" || !isPairs(r.headers)) {
    throw new Error(`Request ${i + 1} needs method, path and headers`);
  }
  return {
    id: crypto.randomUUID(),
    endpointId,
    method: r.method.toUpperCase(),
    path: r.path || "/",
    query: typeof r.query === "string" ? r.query : "",
    headers: r.headers,
    body: decode(r.body, r.bodyEncoding),
    contentType: r.contentType ?? header(r.headers, "content-type"),
    ip: r.ip ?? null,
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt! : Date.now(),
  };
}

function fromHarEntry(e: any, endpointId: string, i: number): NewRequest {
  const req = e?.request;
  if (typeof req?.method !== "string" || typeof req.url !== "string" || !URL.canParse(req.url)) {
    throw new Error(`Entry ${i + 1} needs request.method and a valid request.url`);
  }
  const url = new URL(req.url);
  const headers: HeaderPair[] = Array.isArray(req.headers)
    ? req.headers.map((h: any) => [String(h?.name ?? ""), String(h?.value ?? "")])
    : [];
  const started = Date.parse(e.startedDateTime);
  return {
    id: crypto.randomUUID(),
    endpointId,
    method: req.method.toUpperCase(),
    // Keep the subpath of localhook URLs; other URLs keep their full path.
    path: url.pathname.match(/^\/hook\/[^/]+(\/.*)?$/)?.[1] ?? (url.pathname.startsWith("/hook/") ? "/" : url.pathname),
    query: url.search,
    headers,
    body: decode(req.postData?.text, req.postData?.encoding),
    contentType: req.postData?.mimeType || header(headers, "content-type"),
    ip: null,
    createdAt: Number.isFinite(started) ? started : Date.now(),
  };
}
