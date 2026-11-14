import { decodeBody } from "./db";
import type { HeaderPair, SentRequest } from "./types";

// Headers that describe a single hop/connection; fetch sets its own.
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
  "proxy-authorization",
]);

export interface OutgoingRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string | Uint8Array<ArrayBuffer>;
}

export async function sendRequest(out: OutgoingRequest, timeoutMs: number, maxBodyBytes: number): Promise<SentRequest> {
  const method = out.method.toUpperCase();
  const headers = new Headers();
  for (const [k, v] of out.headers) {
    if (k.trim() && !HOP_BY_HOP.has(k.trim().toLowerCase())) headers.append(k.trim(), v);
  }
  const hasBody = method !== "GET" && method !== "HEAD" && out.body.length > 0;
  const result: SentRequest = {
    id: crypto.randomUUID(),
    method,
    url: out.url,
    headers: out.headers,
    // Keep binary bodies as base64 so the history can send the exact bytes again.
    ...(typeof out.body === "string" ? { body: out.body, bodyEncoding: "utf8" as const } : decodeBody(out.body)),
    status: null,
    responseHeaders: [],
    responseBody: "",
    durationMs: 0,
    error: null,
    createdAt: Date.now(),
  };

  const started = performance.now();
  try {
    const res = await fetch(out.url, {
      method,
      headers,
      body: hasBody ? out.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    result.status = res.status;
    result.responseHeaders = [...res.headers.entries()];
    result.responseBody = new TextDecoder().decode(bytes.subarray(0, maxBodyBytes));
    if (bytes.byteLength > maxBodyBytes) result.error = `Response body truncated to ${maxBodyBytes} bytes`;
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
