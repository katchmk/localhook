// Shared between the server and the web UI.

export type HeaderPair = [name: string, value: string];

/** A response for requests that match `method` and `path`. Empty `method` or `path` matches all. */
export interface ResponseRule {
  method: string;
  /** Subpath after /hook/<id>. `*` matches any characters, e.g. "/orders/*". */
  path: string;
  status: number;
  contentType: string;
  body: string;
  delayMs: number;
}

export const SIGNATURE_SCHEMES = ["github", "stripe", "shopify", "slack", "standard", "custom"] as const;
export type SignatureScheme = (typeof SIGNATURE_SCHEMES)[number];

export const SIGNATURE_ALGORITHMS = ["sha256", "sha1", "sha512"] as const;
export type SignatureAlgorithm = (typeof SIGNATURE_ALGORITHMS)[number];

/** For the "custom" scheme: an HMAC in one header. */
export interface CustomSignature {
  header: string;
  algorithm: SignatureAlgorithm;
  encoding: "hex" | "base64";
  /**
   * What is signed. `{body}` is the raw body and `{header:Name}` is the value of a request header,
   * e.g. "{header:X-Timestamp}.{body}".
   */
  payload: string;
}

export const DEFAULT_CUSTOM_SIGNATURE: CustomSignature = {
  header: "X-Signature",
  algorithm: "sha256",
  encoding: "hex",
  payload: "{body}",
};

export const FORWARD_MODES = ["async", "proxy"] as const;
export type ForwardMode = (typeof FORWARD_MODES)[number];

export interface Endpoint {
  id: string;
  name: string;
  responseStatus: number;
  responseBody: string;
  responseContentType: string;
  responseDelayMs: number;
  /** Checked in order; the first match wins, else the default response above. */
  responseRules: ResponseRule[];
  /** Each captured request is also sent to this URL plus its subpath and query. Empty to disable. */
  forwardUrl: string;
  /**
   * "async": the sender gets the configured response at once.
   * "proxy": the sender gets the forward target's response, unless a response rule matches.
   */
  forwardMode: ForwardMode;
  /** Empty to disable signature checks. */
  signatureScheme: SignatureScheme | "";
  /** The API never returns the secret itself; see GET /api/endpoints/:id/secret. */
  signatureSecretSet: boolean;
  signatureCustom: CustomSignature;
  createdAt: number;
  requestCount: number;
}

export interface ForwardResult {
  url: string;
  status: number | null;
  error: string | null;
  durationMs: number;
}

export interface SignatureCheck {
  scheme: SignatureScheme;
  valid: boolean;
  message: string;
}

export interface CapturedRequestSummary {
  id: string;
  endpointId: string;
  method: string;
  path: string;
  size: number;
  contentType: string | null;
  ip: string | null;
  /** Null when the endpoint has no forward URL, or while the forward is in progress. */
  forward: ForwardResult | null;
  createdAt: number;
}

export interface CapturedRequest extends CapturedRequestSummary {
  query: string;
  headers: HeaderPair[];
  /** UTF-8 text, or base64 when `bodyEncoding` is "base64". */
  body: string;
  bodyEncoding: "utf8" | "base64";
  /** Null when the endpoint has no signature scheme. */
  signature: SignatureCheck | null;
}

/** Signs an outgoing request. The server adds the signature headers just before it sends. */
export interface OutgoingSignature {
  scheme: SignatureScheme;
  secret: string;
  /** Used only for the "custom" scheme. */
  custom: CustomSignature;
}

export interface SendInput {
  method: string;
  url: string;
  headers: HeaderPair[];
  /** UTF-8 text, or base64 when `bodyEncoding` is "base64" (binary files). */
  body: string;
  bodyEncoding?: "utf8" | "base64";
  sign?: OutgoingSignature | null;
}

/** Sender auth. One flat shape for all types, so switching the type keeps what was typed. */
export interface SenderAuth {
  type: "none" | "basic" | "bearer" | "apikey";
  username: string;
  password: string;
  token: string;
  key: string;
  value: string;
  in: "header" | "query";
}

/** A Sender request as it is saved, before variables are filled in. */
export interface SavedRequestData {
  method: string;
  url: string;
  /** Cookies are in a Cookie header. */
  headers: HeaderPair[];
  body: string;
  bodyEncoding: "utf8" | "base64";
  /** The name of a binary body file, for display. */
  fileName: string | null;
  auth: SenderAuth;
  sign: OutgoingSignature | null;
}

export interface SavedRequest {
  id: string;
  collection: string;
  name: string;
  request: SavedRequestData;
  createdAt: number;
  updatedAt: number;
}

export interface SentRequest extends Omit<SendInput, "sign"> {
  id: string;
  bodyEncoding: "utf8" | "base64";
  status: number | null;
  responseHeaders: HeaderPair[];
  responseBody: string;
  durationMs: number;
  error: string | null;
  createdAt: number;
}
