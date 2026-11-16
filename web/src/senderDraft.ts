import type {
  CapturedRequest,
  HeaderPair,
  OutgoingSignature,
  SavedRequestData,
  SenderAuth,
  SendInput,
  SentRequest,
} from "./api";
import type { ParsedCurl } from "./curl";
import { joinCookies, splitCookies } from "./ui";

/** What the Sender editor holds. Values can contain {{variables}}. */
export interface Draft {
  method: string;
  url: string;
  headers: HeaderPair[];
  cookies: HeaderPair[];
  body: string;
  bodyMode: "text" | "file";
  /** Binary body for "file" mode; `data` is base64. */
  file: { name: string; size: number; data: string } | null;
  auth: SenderAuth;
  /** Null when the request is not signed. */
  sign: OutgoingSignature | null;
}

export const noAuth = (): SenderAuth => ({
  type: "none",
  username: "",
  password: "",
  token: "",
  key: "X-API-Key",
  value: "",
  in: "header",
});

export const initialDraft = (): Draft => ({
  method: "POST",
  url: "",
  headers: [["Content-Type", "application/json"]],
  cookies: [],
  body: JSON.stringify({ event: "order.created", data: { id: 123 } }, null, 2),
  bodyMode: "text",
  file: null,
  auth: noAuth(),
  sign: null,
});

// btoa() accepts only Latin-1, so encode UTF-8 first.
const base64Utf8 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const base64Size = (b64: string) => {
  try {
    return atob(b64).length;
  } catch {
    return 0;
  }
};

/** Moves an Authorization: Basic or Bearer header into the auth settings, so the Auth tab shows it. */
function extractAuth(headers: HeaderPair[]): { headers: HeaderPair[]; auth: SenderAuth } {
  const auth = noAuth();
  const i = headers.findIndex(([k]) => k.trim().toLowerCase() === "authorization");
  const match = i === -1 ? null : headers[i]![1].match(/^(Basic|Bearer)\s+(.+)$/i);
  if (!match) return { headers, auth };
  if (match[1]!.toLowerCase() === "bearer") {
    auth.type = "bearer";
    auth.token = match[2]!;
  } else {
    try {
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0)));
      const colon = decoded.indexOf(":");
      if (colon === -1) return { headers, auth: noAuth() };
      auth.type = "basic";
      auth.username = decoded.slice(0, colon);
      auth.password = decoded.slice(colon + 1);
    } catch {
      return { headers, auth: noAuth() }; // Not valid base64: keep it as a plain header.
    }
  }
  return { headers: headers.filter((_, j) => j !== i), auth };
}

/** Adds the auth to the headers or URL. It replaces a header with the same name. */
function applyAuth(auth: SenderAuth, url: string, headers: HeaderPair[]): { url: string; headers: HeaderPair[] } {
  const setHeader = (name: string, value: string) => ({
    url,
    headers: [...headers.filter(([k]) => k.trim().toLowerCase() !== name.toLowerCase()), [name, value] as HeaderPair],
  });
  switch (auth.type) {
    case "none":
      return { url, headers };
    case "basic":
      return setHeader("Authorization", `Basic ${base64Utf8(`${auth.username}:${auth.password}`)}`);
    case "bearer":
      return setHeader("Authorization", `Bearer ${auth.token}`);
    case "apikey": {
      if (!auth.key.trim()) return { url, headers };
      if (auth.in === "header") return setHeader(auth.key.trim(), auth.value);
      const parsed = URL.parse(url);
      if (!parsed) return { url, headers }; // The server reports the invalid URL.
      parsed.searchParams.set(auth.key.trim(), auth.value);
      return { url: parsed.toString(), headers };
    }
  }
}

/** Splits headers into the editor's headers, cookies and auth. */
function fromHeaders(all: HeaderPair[]) {
  const split = splitCookies(all);
  const { headers, auth } = extractAuth(split.headers);
  return { headers: headers.length ? headers : [["", ""] as HeaderPair], cookies: split.cookies, auth };
}

const body = (text: string, encoding: "utf8" | "base64", fileName: string) =>
  encoding === "base64"
    ? { body: "", bodyMode: "file" as const, file: { name: fileName, size: base64Size(text), data: text } }
    : { body: text, bodyMode: "text" as const, file: null };

// Headers of a captured request that describe its original connection.
const CAPTURE_ONLY = new Set(["host", "content-length", "connection", "transfer-encoding"]);

/** A draft that sends a captured request again: to its forward URL if it had one, else to its hook URL. */
export const draftFromCaptured = (r: CapturedRequest): Draft => ({
  method: r.method,
  url: r.forward?.url ?? `http://localhost:8080/hook/${r.endpointId}${r.path === "/" ? "" : r.path}${r.query}`,
  ...fromHeaders(r.headers.filter(([k]) => !CAPTURE_ONLY.has(k.toLowerCase()))),
  ...body(r.body, r.bodyEncoding, "Binary body from captured request"),
  sign: null,
});

export const draftFromSent = (s: SentRequest): Draft => ({
  method: s.method,
  url: s.url,
  ...fromHeaders(s.headers),
  ...body(s.body, s.bodyEncoding, "Binary body from history"),
  sign: null,
});

export const draftFromSaved = (r: SavedRequestData): Draft => {
  const { headers, cookies } = fromHeaders(r.headers);
  return {
    method: r.method,
    url: r.url,
    headers,
    cookies,
    ...body(r.body, r.bodyEncoding, r.fileName ?? "Binary body"),
    // The saved auth wins over an Authorization header, which fromHeaders would also read.
    auth: r.auth,
    sign: r.sign,
  };
};

export const draftToSaved = (d: Draft): SavedRequestData => ({
  method: d.method,
  url: d.url,
  headers: joinCookies(d.headers.filter(([k]) => k.trim()), d.cookies),
  ...(d.bodyMode === "file"
    ? { body: d.file?.data ?? "", bodyEncoding: "base64", fileName: d.file?.name ?? null }
    : { body: d.body, bodyEncoding: "utf8", fileName: null }),
  auth: d.auth,
  sign: d.sign,
});

export const draftFromCurl = (p: ParsedCurl): Draft => {
  const draft: Draft = {
    method: p.method,
    url: p.url,
    ...fromHeaders(p.headers),
    ...body(p.body, p.bodyEncoding, "Binary body from cURL"),
    sign: null,
  };
  if (p.basicAuth) draft.auth = { ...noAuth(), type: "basic", ...p.basicAuth };
  return draft;
};

const VARIABLE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** Replaces {{name}} with its value. Unknown names stay as they are. */
const fill = (text: string, vars: Map<string, string>) =>
  text.replace(VARIABLE, (whole, name: string) => vars.get(name) ?? whole);

/** Each text in the draft that can hold variables. */
function texts(d: Draft): string[] {
  const a = d.auth;
  return [
    d.url,
    ...d.headers.flat(),
    ...d.cookies.flat(),
    d.bodyMode === "text" ? d.body : "",
    a.username,
    a.password,
    a.token,
    a.key,
    a.value,
    d.sign?.secret ?? "",
  ];
}

/** Names used as {{name}} in the draft that have no variable. */
export function unknownVariables(d: Draft, variables: HeaderPair[]): string[] {
  const known = new Set(variables.map(([k]) => k));
  const used = texts(d).flatMap((t) => [...t.matchAll(VARIABLE)].map((m) => m[1]!));
  return [...new Set(used)].filter((name) => !known.has(name));
}

/** The request to send: variables filled in, then cookies and auth added. */
export function toSendInput(d: Draft, variables: HeaderPair[]): SendInput {
  const vars = new Map(variables);
  const f = (s: string) => fill(s, vars);
  const pairs = (p: HeaderPair[]) => p.filter(([k]) => k.trim()).map(([k, v]): HeaderPair => [f(k), f(v)]);
  const auth = Object.fromEntries(Object.entries(d.auth).map(([k, v]) => [k, f(v)])) as unknown as SenderAuth;
  return {
    method: d.method,
    ...applyAuth(auth, f(d.url), joinCookies(pairs(d.headers), pairs(d.cookies))),
    ...(d.bodyMode === "file"
      ? { body: d.file?.data ?? "", bodyEncoding: "base64" }
      : { body: f(d.body), bodyEncoding: "utf8" }),
    sign: d.sign && { ...d.sign, secret: f(d.sign.secret) },
  };
}
