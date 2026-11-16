import { describe, expect, test } from "bun:test";
import { parseCurl, shellWords } from "./curl";
import { multipartBoundary, parseMultipart } from "./multipart";
import { toCurl } from "./ui";

describe("shellWords", () => {
  test("handles quotes, escapes and line continuations", () => {
    expect(shellWords(`curl 'a b' "c \\"d\\" $x" e\\ f \\\n g $'h\\ni'`)).toEqual([
      "curl",
      "a b",
      'c "d" $x',
      "e f",
      "g",
      "h\ni",
    ]);
    expect(() => shellWords("curl 'open")).toThrow();
  });
});

describe("parseCurl", () => {
  test("reads method, headers, body and basic auth", () => {
    const r = parseCurl(`curl -sS -XPUT https://api.test/x?y=1 -H 'Content-Type: application/json' \\
      -H "X-A:  b" -u alice:pw --data-raw '{"a":1}' --compressed -o out.txt`);
    expect(r).toMatchObject({
      method: "PUT",
      url: "https://api.test/x?y=1",
      headers: [
        ["Content-Type", "application/json"],
        ["X-A", "b"],
      ],
      body: '{"a":1}',
      bodyEncoding: "utf8",
      basicAuth: { username: "alice", password: "pw" },
      warnings: [],
    });
  });

  test("defaults to POST with a form body, and GET without one", () => {
    const post = parseCurl("curl example.test -d a=1 -d b=2 --data-urlencode 'c=x y'");
    expect(post.method).toBe("POST");
    expect(post.url).toBe("http://example.test");
    expect(post.body).toBe("a=1&b=2&c=x%20y");
    expect(post.headers).toContainEqual(["Content-Type", "application/x-www-form-urlencoded"]);
    expect(parseCurl("curl --url=https://x.test").method).toBe("GET");
    expect(parseCurl("curl -G https://x.test?a=1 -d b=2").url).toBe("https://x.test?a=1&b=2");
    expect(parseCurl("curl -G '{{base}}/x' -d b=2").url).toBe("{{base}}/x?b=2");
  });

  test("warns about files it cannot read", () => {
    expect(parseCurl("curl https://x.test -d @body.json").warnings[0]).toContain("body.json");
    expect(() => parseCurl("wget https://x.test")).toThrow();
    expect(() => parseCurl("curl -H 'A: b'")).toThrow();
  });

  test("reads back what Copy as cURL makes, also for binary bodies", () => {
    const text = { method: "POST", url: "https://x.test/a", headers: [["Content-Type", "text/plain"], ["X-Q", "it's"]] as [string, string][], body: "o'k" };
    expect(parseCurl(toCurl(text))).toMatchObject({ method: "POST", url: text.url, headers: text.headers, body: "o'k" });

    const binary = { ...text, body: "/wA=", bodyEncoding: "base64" };
    expect(parseCurl(toCurl(binary))).toMatchObject({ body: "/wA=", bodyEncoding: "base64" });
    expect(parseCurl(toCurl({ ...text, method: "HEAD", body: "" })).method).toBe("HEAD");
  });
});

describe("parseMultipart", () => {
  const body = (eol: string) =>
    new TextEncoder().encode(
      [
        "preamble",
        "--XyZ",
        'Content-Disposition: form-data; name="field"',
        "",
        "value 1",
        "--XyZ",
        'Content-Disposition: form-data; name="file"; filename="a \\"b\\".txt"',
        "Content-Type: text/plain",
        "",
        "line 1",
        "line 2",
        "--XyZ--",
        "",
      ].join(eol),
    );

  test("finds the boundary", () => {
    expect(multipartBoundary('multipart/form-data; boundary="XyZ"')).toBe("XyZ");
    expect(multipartBoundary("multipart/form-data; charset=utf-8; boundary=XyZ")).toBe("XyZ");
    expect(multipartBoundary("application/json")).toBeNull();
  });

  for (const eol of ["\r\n", "\n"]) {
    test(`splits parts with ${JSON.stringify(eol)} line breaks`, () => {
      const parts = parseMultipart(body(eol), "XyZ");
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatchObject({ name: "field", filename: null, contentType: null });
      expect(new TextDecoder().decode(parts[0]!.data)).toBe("value 1");
      expect(parts[1]).toMatchObject({ name: "file", filename: 'a "b".txt', contentType: "text/plain" });
      expect(new TextDecoder().decode(parts[1]!.data)).toBe(`line 1${eol}line 2`);
    });
  }

  test("keeps binary bytes", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const bytes = new Uint8Array([
      ...enc('--b\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\n\r\n'),
      0x00, 0xff, 0x0d, 0x0a, 0x2d,
      ...enc("\r\n--b--\r\n"),
    ]);
    expect([...parseMultipart(bytes, "b")[0]!.data]).toEqual([0x00, 0xff, 0x0d, 0x0a, 0x2d]);
    expect(() => parseMultipart(enc("no parts"), "b")).toThrow();
  });
});
