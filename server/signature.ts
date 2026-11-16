import { createHmac, timingSafeEqual } from "node:crypto";
import type { CustomSignature, HeaderPair, OutgoingSignature, SignatureCheck, SignatureScheme } from "./types";

type Part = string | Uint8Array;

const hmacWith = (algorithm: string, key: string | Buffer, ...parts: Part[]) => {
  const h = createHmac(algorithm, key);
  for (const part of parts) h.update(part);
  return h.digest();
};

const hmac = (key: string | Buffer, ...parts: Part[]) => hmacWith("sha256", key, ...parts);

const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** True when any of `candidates` (encoded as `encoding`) equals `expected`. */
const matchesAny = (expected: Buffer, candidates: string[], encoding: "hex" | "base64") =>
  candidates.some((c) => sameBytes(expected, Buffer.from(c, encoding)));

/** Standard Webhooks secrets are base64 after a "whsec_" prefix. */
const standardKey = (secret: string) => Buffer.from(secret.replace(/^whsec_/, ""), "base64");

const headerLookup = (headers: HeaderPair[]) => (name: string) =>
  headers.find(([k]) => k.trim().toLowerCase() === name.toLowerCase())?.[1];

/**
 * Builds the signed parts from a custom payload template: `{body}` is the raw body and
 * `{header:Name}` a header value. Returns the name of a missing header instead.
 */
function customParts(
  template: string,
  header: (name: string) => string | undefined,
  body: Uint8Array,
): Part[] | { missing: string } {
  const parts: Part[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{body\}|\{header:([^}]+)\}/g)) {
    parts.push(template.slice(last, m.index));
    if (m[1] === undefined) {
      parts.push(body);
    } else {
      const value = header(m[1].trim());
      if (value === undefined) return { missing: m[1].trim() };
      parts.push(value);
    }
    last = m.index + m[0].length;
  }
  parts.push(template.slice(last));
  return parts;
}

/**
 * Checks the signature header of a captured request against `secret`.
 * Timestamps are not checked for age, so old requests still verify.
 */
export function checkSignature(
  scheme: SignatureScheme,
  secret: string,
  headers: HeaderPair[],
  body: Uint8Array,
  custom?: CustomSignature,
): SignatureCheck {
  const header = headerLookup(headers);
  const result = (valid: boolean, message: string): SignatureCheck => ({ scheme, valid, message });
  const verdict = (valid: boolean) => result(valid, valid ? "Signature matches" : "Signature does not match");
  const missing = (name: string) => result(false, `Missing ${name} header`);
  if (!secret) return result(false, "No signing secret is set for this endpoint");

  switch (scheme) {
    case "github": {
      const sig = header("x-hub-signature-256");
      if (!sig) return missing("X-Hub-Signature-256");
      return verdict(matchesAny(hmac(secret, body), [sig.replace(/^sha256=/, "")], "hex"));
    }
    case "shopify": {
      const sig = header("x-shopify-hmac-sha256");
      if (!sig) return missing("X-Shopify-Hmac-Sha256");
      return verdict(matchesAny(hmac(secret, body), [sig], "base64"));
    }
    case "stripe": {
      const sig = header("stripe-signature");
      if (!sig) return missing("Stripe-Signature");
      const parts = sig.split(",").map((p) => p.trim().split("=", 2) as [string, string?]);
      const t = parts.find(([k]) => k === "t")?.[1];
      const v1 = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
      if (!t || v1.length === 0) return result(false, "Stripe-Signature has no t= or v1= value");
      return verdict(matchesAny(hmac(secret, `${t}.`, body), v1, "hex"));
    }
    case "slack": {
      const sig = header("x-slack-signature");
      const ts = header("x-slack-request-timestamp");
      if (!sig) return missing("X-Slack-Signature");
      if (!ts) return missing("X-Slack-Request-Timestamp");
      return verdict(matchesAny(hmac(secret, `v0:${ts}:`, body), [sig.replace(/^v0=/, "")], "hex"));
    }
    case "standard": {
      // https://www.standardwebhooks.com, also used by Svix with "svix-" header names.
      const get = (name: string) => header(`webhook-${name}`) ?? header(`svix-${name}`);
      const id = get("id");
      const ts = get("timestamp");
      const sig = get("signature");
      if (!id) return missing("webhook-id");
      if (!ts) return missing("webhook-timestamp");
      if (!sig) return missing("webhook-signature");
      const v1 = sig
        .split(" ")
        .filter((s) => s.startsWith("v1,"))
        .map((s) => s.slice(3));
      return verdict(matchesAny(hmac(standardKey(secret), `${id}.${ts}.`, body), v1, "base64"));
    }
    case "custom": {
      if (!custom?.header) return result(false, "No signature header is set for this endpoint");
      const sig = header(custom.header);
      if (!sig) return missing(custom.header);
      const parts = customParts(custom.payload, header, body);
      if (!Array.isArray(parts)) return missing(parts.missing);
      // Accept an "<algorithm>=" prefix, e.g. "sha256=<hex>".
      const value = sig.trim().replace(new RegExp(`^${custom.algorithm}=`, "i"), "");
      return verdict(matchesAny(hmacWith(custom.algorithm, secret, ...parts), [value], custom.encoding));
    }
  }
}

/**
 * Returns `headers` plus the signature headers for `sign`, replacing headers with the same names.
 * Returns an error message for the user instead when the request cannot be signed.
 */
export function signRequest(
  sign: OutgoingSignature,
  headers: HeaderPair[],
  body: Uint8Array,
  now = Date.now(),
): HeaderPair[] | string {
  const ts = String(Math.floor(now / 1000));
  const added: HeaderPair[] = [];
  switch (sign.scheme) {
    case "github":
      added.push(["X-Hub-Signature-256", `sha256=${hmac(sign.secret, body).toString("hex")}`]);
      break;
    case "shopify":
      added.push(["X-Shopify-Hmac-Sha256", hmac(sign.secret, body).toString("base64")]);
      break;
    case "stripe":
      added.push(["Stripe-Signature", `t=${ts},v1=${hmac(sign.secret, `${ts}.`, body).toString("hex")}`]);
      break;
    case "slack":
      added.push(["X-Slack-Request-Timestamp", ts]);
      added.push(["X-Slack-Signature", `v0=${hmac(sign.secret, `v0:${ts}:`, body).toString("hex")}`]);
      break;
    case "standard": {
      const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
      const sig = hmac(standardKey(sign.secret), `${id}.${ts}.`, body).toString("base64");
      added.push(["webhook-id", id], ["webhook-timestamp", ts], ["webhook-signature", `v1,${sig}`]);
      break;
    }
    case "custom": {
      const name = sign.custom.header.trim();
      if (!name) return "The custom signature needs a header name";
      const parts = customParts(sign.custom.payload, headerLookup(headers), body);
      if (!Array.isArray(parts)) {
        return `The signature payload uses the ${parts.missing} header, but the request has no such header`;
      }
      added.push([name, hmacWith(sign.custom.algorithm, sign.secret, ...parts).toString(sign.custom.encoding)]);
      break;
    }
  }
  const names = new Set(added.map(([k]) => k.toLowerCase()));
  return [...headers.filter(([k]) => !names.has(k.trim().toLowerCase())), ...added];
}
