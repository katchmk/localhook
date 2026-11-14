// Shared between the server and the web UI.

export type HeaderPair = [name: string, value: string];

export interface Endpoint {
  id: string;
  name: string;
  responseStatus: number;
  responseBody: string;
  responseContentType: string;
  createdAt: number;
  requestCount: number;
}

export interface CapturedRequestSummary {
  id: string;
  endpointId: string;
  method: string;
  path: string;
  size: number;
  contentType: string | null;
  ip: string | null;
  createdAt: number;
}

export interface CapturedRequest extends CapturedRequestSummary {
  query: string;
  headers: HeaderPair[];
  /** UTF-8 text, or base64 when `bodyEncoding` is "base64". */
  body: string;
  bodyEncoding: "utf8" | "base64";
}

export interface SendInput {
  method: string;
  url: string;
  headers: HeaderPair[];
  /** UTF-8 text, or base64 when `bodyEncoding` is "base64" (binary files). */
  body: string;
  bodyEncoding?: "utf8" | "base64";
}

export interface SentRequest extends SendInput {
  id: string;
  bodyEncoding: "utf8" | "base64";
  status: number | null;
  responseHeaders: HeaderPair[];
  responseBody: string;
  durationMs: number;
  error: string | null;
  createdAt: number;
}
