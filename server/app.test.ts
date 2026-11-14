import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { openStore, type Store } from "./db";
import { createHub } from "./hub";
import type { CapturedRequest, CapturedRequestSummary, Endpoint, SentRequest } from "./types";

let store: Store;
let app: ReturnType<typeof createApp>;

const config = { maxBodyBytes: 1024, maxRequestsPerEndpoint: 3, maxSent: 10, sendTimeoutMs: 5000 };

beforeEach(() => {
  store = openStore(":memory:");
  app = createApp(store, createHub(), config);
});
afterEach(() => store.close());

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function createEndpoint(id = "test"): Promise<Endpoint> {
  const res = await app.request("/api/endpoints", json({ id }));
  expect(res.status).toBe(201);
  return res.json();
}

describe("endpoints", () => {
  test("creates with a random id when none is given", async () => {
    const res = await app.request("/api/endpoints", { method: "POST" });
    const ep = (await res.json()) as Endpoint;
    expect(ep.id).toMatch(/^[a-z0-9]{10}$/);
  });

  test("rejects invalid and duplicate ids", async () => {
    expect((await app.request("/api/endpoints", json({ id: "a/b" }))).status).toBe(400);
    await createEndpoint("dup");
    expect((await app.request("/api/endpoints", json({ id: "dup" }))).status).toBe(409);
  });
});

describe("receiver", () => {
  test("captures any method, subpath, query, headers and raw body", async () => {
    await createEndpoint();
    const res = await app.request("/hook/test/a/b?x=1", {
      method: "PUT",
      headers: { "content-type": "text/plain", "x-custom": "yes" },
      body: "hello",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const [summary] = (await (await app.request("/api/endpoints/test/requests")).json()) as CapturedRequestSummary[];
    expect(summary).toMatchObject({ method: "PUT", path: "/a/b", size: 5, contentType: "text/plain" });

    const full = (await (await app.request(`/api/requests/${summary!.id}`)).json()) as CapturedRequest;
    expect(full.query).toBe("?x=1");
    expect(full.body).toBe("hello");
    expect(full.bodyEncoding).toBe("utf8");
    expect(full.headers).toContainEqual(["x-custom", "yes"]);
  });

  test("stores non-UTF-8 bodies as base64", async () => {
    await createEndpoint();
    await app.request("/hook/test", { method: "POST", body: new Uint8Array([0xff, 0xfe, 0x00]) });
    const [summary] = (await (await app.request("/api/endpoints/test/requests")).json()) as CapturedRequestSummary[];
    const full = (await (await app.request(`/api/requests/${summary!.id}`)).json()) as CapturedRequest;
    expect(full.bodyEncoding).toBe("base64");
    expect(full.body).toBe(Buffer.from([0xff, 0xfe, 0x00]).toString("base64"));
  });

  test("returns the configured response", async () => {
    await createEndpoint();
    await app.request("/api/endpoints/test", {
      method: "PATCH",
      body: JSON.stringify({ responseStatus: 202, responseBody: "queued", responseContentType: "text/plain" }),
    });
    const res = await app.request("/hook/test", { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("queued");
  });

  test("returns 404 for unknown endpoints and 413 for large bodies", async () => {
    expect((await app.request("/hook/nope", { method: "POST" })).status).toBe(404);
    await createEndpoint();
    const res = await app.request("/hook/test", { method: "POST", body: "x".repeat(config.maxBodyBytes + 1) });
    expect(res.status).toBe(413);
  });

  test("keeps only the newest N requests per endpoint", async () => {
    await createEndpoint();
    for (let i = 0; i < 5; i++) {
      await app.request(`/hook/test/${i}`, { method: "POST" });
      await Bun.sleep(2); // distinct created_at
    }
    const list = (await (await app.request("/api/endpoints/test/requests")).json()) as CapturedRequestSummary[];
    expect(list.map((r) => r.path)).toEqual(["/4", "/3", "/2"]);
  });
});

describe("sender", () => {
  test("sends a request and replays a captured one to a live server", async () => {
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      await createEndpoint("target");
      const url = `http://localhost:${server.port}/hook/target/sent`;

      const sendRes = await app.request(
        "/api/send",
        json({ method: "POST", url, headers: [["x-from", "sender"]], body: '{"a":1}' }),
      );
      const sent = (await sendRes.json()) as SentRequest;
      expect(sent.error).toBeNull();
      expect(sent.status).toBe(200);

      const [captured] = (await (await app.request("/api/endpoints/target/requests")).json()) as CapturedRequestSummary[];
      expect(captured!.path).toBe("/sent");
      await Bun.sleep(2); // distinct created_at

      const replay = (await (
        await app.request(`/api/requests/${captured!.id}/replay`, json({ url: url.replace("/sent", "/replayed") }))
      ).json()) as SentRequest;
      expect(replay.status).toBe(200);

      const all = (await (await app.request("/api/endpoints/target/requests")).json()) as CapturedRequestSummary[];
      expect(all[0]!.path).toBe("/replayed");
      const full = (await (await app.request(`/api/requests/${all[0]!.id}`)).json()) as CapturedRequest;
      expect(full.body).toBe('{"a":1}');
      expect(full.headers).toContainEqual(["x-from", "sender"]);

      const history = (await (await app.request("/api/sent")).json()) as SentRequest[];
      expect(history).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });

  test("sends a base64 body as raw bytes and keeps it in the history", async () => {
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      await createEndpoint("bin");
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      const body = Buffer.from(bytes).toString("base64");
      const sent = (await (
        await app.request(
          "/api/send",
          json({ method: "POST", url: `http://localhost:${server.port}/hook/bin`, headers: [], body, bodyEncoding: "base64" }),
        )
      ).json()) as SentRequest;
      expect(sent.status).toBe(200);
      expect(sent.bodyEncoding).toBe("base64");
      expect(sent.body).toBe(body);

      const [captured] = (await (await app.request("/api/endpoints/bin/requests")).json()) as CapturedRequestSummary[];
      const full = (await (await app.request(`/api/requests/${captured!.id}`)).json()) as CapturedRequest;
      expect(full.bodyEncoding).toBe("base64");
      expect(full.body).toBe(body);

      const download = await app.request(`/api/requests/${captured!.id}/body`);
      expect(download.headers.get("content-disposition")).toStartWith("attachment;");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

      const [last] = (await (await app.request("/api/sent")).json()) as SentRequest[];
      expect(last!.bodyEncoding).toBe("base64");
      expect(last!.body).toBe(body);
    } finally {
      server.stop(true);
    }
  });

  test("reports connection errors instead of failing", async () => {
    const sent = (await (
      await app.request("/api/send", json({ method: "GET", url: "http://127.0.0.1:1/" }))
    ).json()) as SentRequest;
    expect(sent.status).toBeNull();
    expect(sent.error).toBeTruthy();
  });
});
