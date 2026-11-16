import type { HeaderPair } from "./api";

export interface MultipartPart {
  /** From Content-Disposition. */
  name: string | null;
  filename: string | null;
  contentType: string | null;
  headers: HeaderPair[];
  data: Uint8Array;
}

/** The boundary of a multipart Content-Type, or null. */
export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType || !/^multipart\//i.test(contentType.trim())) return null;
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return m?.[1] ?? m?.[2] ?? null;
}

const ascii = (s: string) => new TextEncoder().encode(s);

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** The value of `key` in a header such as `form-data; name="a"; filename="b.txt"`. */
function param(header: string, key: string): string | null {
  const m = header.match(new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, "i"));
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!.trim();
}

/** Splits a multipart body (RFC 7578) into its parts. Accepts CRLF or LF line breaks. Throws when it finds no parts. */
export function parseMultipart(body: Uint8Array, boundary: string): MultipartPart[] {
  const delimiter = ascii(`--${boundary}`);
  const nextDelimiter = ascii(`\n--${boundary}`);
  const parts: MultipartPart[] = [];

  let pos = indexOf(body, delimiter, 0);
  if (pos === -1) throw new Error("The body does not contain the boundary");
  for (;;) {
    let start = pos + delimiter.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // "--": the closing delimiter.
    // Skip the rest of the delimiter line.
    while (start < body.length && body[start] !== 0x0a) start++;
    start++;

    const end = indexOf(body, nextDelimiter, start);
    if (end === -1) break; // No closing delimiter: ignore the incomplete part.
    const part = body.subarray(start, body[end - 1] === 0x0d ? end - 1 : end);

    // Headers end at the first empty line.
    let split = indexOf(part, ascii("\r\n\r\n"), 0);
    let gap = 4;
    const lf = indexOf(part, ascii("\n\n"), 0);
    if (split === -1 || (lf !== -1 && lf < split)) [split, gap] = [lf, 2];
    const headerText = split === -1 ? "" : new TextDecoder().decode(part.subarray(0, split));
    const headers: HeaderPair[] = headerText
      .split(/\r?\n/)
      .filter((line) => line.includes(":"))
      .map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
      });
    const get = (name: string) => headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
    const disposition = get("content-disposition") ?? "";
    parts.push({
      name: param(disposition, "name"),
      filename: param(disposition, "filename"),
      contentType: get("content-type"),
      headers,
      data: split === -1 ? part : part.subarray(split + gap),
    });
    pos = end + 1; // The delimiter starts after the "\n".
  }
  if (parts.length === 0) throw new Error("The body has no parts");
  return parts;
}
