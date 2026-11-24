import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
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

const patch = (id: string, body: unknown) =>
  app.request(`/api/endpoints/${id}`, { method: "PATCH", body: JSON.stringify(body) });

const listRequests = async (query = "") =>
  (await (await app.request(`/api/endpoints/test/requests${query}`)).json()) as CapturedRequestSummary[];

const getRequest = async (id: string) => (await (await app.request(`/api/requests/${id}`)).json()) as CapturedRequest;

describe("response rules", () => {
  test("uses the first matching rule, else the default response", async () => {
    await createEndpoint();
    const res = await patch("test", {
      responseRules: [
        { method: "post", path: "/orders/*", status: 500, contentType: "text/plain", body: "boom" },
        { path: "/slow", status: 202, body: "late", delayMs: 50 },
      ],
    });
    expect(res.status).toBe(200);

    const fail = await app.request("/hook/test/orders/1", { method: "POST" });
    expect(fail.status).toBe(500);
    expect(await fail.text()).toBe("boom");
    expect((await app.request("/hook/test/orders/1", { method: "GET" })).status).toBe(200);

    const started = performance.now();
    const slow = await app.request("/hook/test/slow", { method: "GET" });
    expect(slow.status).toBe(202);
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  test("rejects invalid patches", async () => {
    await createEndpoint();
    expect((await patch("test", { responseRules: [{ status: 99 }] })).status).toBe(400);
    expect((await patch("test", { responseDelayMs: -1 })).status).toBe(400);
    expect((await patch("test", { forwardUrl: "ftp://x" })).status).toBe(400);
    expect((await patch("test", { signatureScheme: "nope" })).status).toBe(400);
  });
});

describe("auto-forward", () => {
  test("forwards each request with its subpath and query and saves the result", async () => {
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      await createEndpoint("target");
      await createEndpoint();
      await patch("test", { forwardUrl: `http://localhost:${server.port}/hook/target/base?k=v` });
      await app.request("/hook/test/orders?x=1", { method: "POST", headers: { "x-a": "1" }, body: "hi" });

      let [summary] = await listRequests();
      for (let i = 0; i < 100 && !summary!.forward; i++) {
        await Bun.sleep(10);
        [summary] = await listRequests();
      }
      expect(summary!.forward).toMatchObject({ status: 200, error: null });
      expect(summary!.forward!.url).toBe(`http://localhost:${server.port}/hook/target/base/orders?k=v&x=1`);

      const [forwarded] = (await (await app.request("/api/endpoints/target/requests")).json()) as CapturedRequestSummary[];
      const full = await getRequest(forwarded!.id);
      expect(full.path).toBe("/base/orders");
      expect(full.body).toBe("hi");
      expect(full.headers).toContainEqual(["x-a", "1"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("signatures", () => {
  const body = '{"event":"ping"}';
  const hex = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest("hex");

  async function capture(headers: Record<string, string>) {
    await Bun.sleep(2); // distinct created_at, so the newest request is this one
    await app.request("/hook/test", { method: "POST", headers, body });
    const [summary] = await listRequests();
    return (await getRequest(summary!.id)).signature;
  }

  test("checks GitHub signatures", async () => {
    await createEndpoint();
    await patch("test", { signatureScheme: "github", signatureSecret: "s3cret" });
    expect(await capture({ "x-hub-signature-256": `sha256=${hex("s3cret", body)}` })).toMatchObject({ valid: true });
    expect(await capture({ "x-hub-signature-256": `sha256=${hex("wrong", body)}` })).toMatchObject({ valid: false });
    expect((await capture({}))!.message).toContain("Missing");
  });

  test("checks Stripe and Standard Webhooks signatures", async () => {
    await createEndpoint();
    await patch("test", { signatureScheme: "stripe", signatureSecret: "whsec_abc" });
    const t = "1700000000";
    expect(await capture({ "stripe-signature": `t=${t},v1=bad,v1=${hex("whsec_abc", `${t}.${body}`)}` })).toMatchObject({
      valid: true,
    });

    const key = Buffer.from("standard-key");
    await patch("test", { signatureScheme: "standard", signatureSecret: `whsec_${key.toString("base64")}` });
    const sig = createHmac("sha256", key).update(`msg_1.${t}.${body}`).digest("base64");
    expect(
      await capture({ "webhook-id": "msg_1", "webhook-timestamp": t, "webhook-signature": `v1,bad v1,${sig}` }),
    ).toMatchObject({ valid: true });
  });

  test("checks a custom header, algorithm and encoding", async () => {
    await createEndpoint();
    await patch("test", {
      signatureScheme: "custom",
      signatureSecret: "k",
      signatureCustom: { header: "X-My-Sig", algorithm: "sha1", encoding: "base64" },
    });
    const sig = createHmac("sha1", "k").update(body).digest("base64");
    expect(await capture({ "x-my-sig": sig })).toMatchObject({ valid: true });
    expect(await capture({ "x-my-sig": `sha1=${sig}` })).toMatchObject({ valid: true });
    expect(await capture({ "x-my-sig": "nope" })).toMatchObject({ valid: false });
    expect((await capture({}))!.message).toBe("Missing X-My-Sig header");

    expect((await patch("test", { signatureCustom: { header: "bad header", algorithm: "sha256", encoding: "hex" } })).status).toBe(400);
    expect((await patch("test", { signatureCustom: { header: "x", algorithm: "md5", encoding: "hex" } })).status).toBe(400);
  });

  test("returns null without a scheme", async () => {
    await createEndpoint();
    expect(await capture({})).toBeNull();
  });
});

describe("search", () => {
  test("filters by method and by text in path, headers and body", async () => {
    await createEndpoint();
    await app.request("/hook/test/a", { method: "POST", body: "needle in body" });
    await app.request("/hook/test/b", { method: "PUT", headers: { "x-tag": "Needle" } });
    await app.request("/hook/test/needle", { method: "GET" });
    await app.request("/hook/test/c", { method: "POST", body: "other" });

    expect((await listRequests("?q=needle")).map((r) => r.path).sort()).toEqual(["/a", "/b", "/needle"]);
    expect((await listRequests("?q=needle&method=post")).map((r) => r.path)).toEqual(["/a"]);
    expect(await listRequests("?q=50%25_")).toEqual([]);
  });
});

describe("import and export", () => {
  test("imports a JSON export and a HAR export into another endpoint", async () => {
    await createEndpoint();
    await createEndpoint("copy");
    await createEndpoint("har");
    await app.request("/hook/test/x?y=1", { method: "POST", headers: { "x-a": "1" }, body: "hello" });
    await app.request("/hook/test/bin", { method: "PUT", body: new Uint8Array([0xff, 0x00]) });

    const exported = await (await app.request("/api/endpoints/test/export")).json();
    const res = await app.request("/api/endpoints/copy/import", json(exported));
    expect(await res.json()).toEqual({ imported: 2 });

    const har = await (await app.request("/api/endpoints/test/export?format=har")).json();
    expect(har.log.entries).toHaveLength(2);
    await app.request("/api/endpoints/har/import", json(har));

    for (const id of ["copy", "har"]) {
      const list = (await (await app.request(`/api/endpoints/${id}/requests`)).json()) as CapturedRequestSummary[];
      const full = await Promise.all(list.map((r) => getRequest(r.id)));
      const x = full.find((r) => r.path === "/x")!;
      expect(x).toMatchObject({ method: "POST", query: "?y=1", body: "hello" });
      expect(x.headers).toContainEqual(["x-a", "1"]);
      expect(full.find((r) => r.path === "/bin")).toMatchObject({ bodyEncoding: "base64", body: "/wA=" });
    }
  });

  test("rejects files it cannot read", async () => {
    await createEndpoint();
    expect((await app.request("/api/endpoints/test/import", json({ nope: 1 }))).status).toBe(400);
    expect((await app.request("/api/endpoints/test/import", json([{ method: "GET" }]))).status).toBe(400);
  });
});

describe("auth", () => {
  test("protects the API but not webhook URLs", async () => {
    app = createApp(store, createHub(), { ...config, auth: { username: "admin", password: "pw" } });
    const basic = { authorization: `Basic ${btoa("admin:pw")}` };
    expect((await app.request("/api/endpoints")).status).toBe(401);
    const created = await app.request("/api/endpoints", { ...json({ id: "test" }), headers: { ...json({}).headers, ...basic } });
    expect(created.status).toBe(201);
    expect((await app.request("/hook/test", { method: "POST" })).status).toBe(200);
    expect((await app.request("/api/endpoints/test/requests", { headers: basic })).status).toBe(200);
  });
});

describe("proxy mode", () => {
  test("returns the forward target's response, unless a rule matches", async () => {
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      await createEndpoint("target");
      await patch("target", { responseStatus: 201, responseBody: "from target", responseContentType: "text/plain" });
      await createEndpoint();
      await patch("test", {
        forwardUrl: `http://localhost:${server.port}/hook/target`,
        forwardMode: "proxy",
        responseRules: [{ path: "/local", status: 418, body: "rule" }],
      });

      const res = await app.request("/hook/test/x", { method: "POST", body: "hi" });
      expect(res.status).toBe(201);
      expect(await res.text()).toBe("from target");
      expect(res.headers.get("content-type")).toBe("text/plain");
      const [summary] = await listRequests();
      expect(summary!.forward).toMatchObject({ status: 201 }); // Saved before the response.

      const local = await app.request("/hook/test/local", { method: "POST" });
      expect(local.status).toBe(418);
      // A matching rule still forwards in the background; wait so it does not outlive the test.
      for (let i = 0; i < 100 && (await listRequests()).some((r) => !r.forward); i++) await Bun.sleep(10);
    } finally {
      server.stop(true);
    }
  });

  test("returns 502 when the forward target cannot be reached", async () => {
    await createEndpoint();
    await patch("test", { forwardUrl: "http://127.0.0.1:1/", forwardMode: "proxy" });
    const res = await app.request("/hook/test", { method: "POST" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toStartWith("Forward failed");
  });
});

describe("forward loops", () => {
  test("stop after a fixed number of hops", async () => {
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      await createEndpoint("a");
      await createEndpoint("b");
      await patch("a", { forwardUrl: `http://localhost:${server.port}/hook/b` });
      await patch("b", { forwardUrl: `http://localhost:${server.port}/hook/a` });
      await app.request("/hook/a", { method: "POST" });

      const count = async () =>
        ((await (await app.request("/api/endpoints/a/requests")).json()) as unknown[]).length +
        ((await (await app.request("/api/endpoints/b/requests")).json()) as unknown[]).length;
      let last = -1;
      for (let i = 0; i < 100; i++) {
        await Bun.sleep(20);
        const now = await count();
        if (now === last) break;
        last = now;
      }
      // The first request plus MAX_HOPS forwards.
      expect(last).toBe(6);
    } finally {
      server.stop(true);
    }
  });
});

describe("signature secret", () => {
  test("is not returned with the endpoint, only on request", async () => {
    await createEndpoint();
    await patch("test", { signatureScheme: "github", signatureSecret: "hidden" });
    const ep = (await (await app.request("/api/endpoints/test")).json()) as Record<string, unknown>;
    expect(ep.signatureSecretSet).toBe(true);
    expect(JSON.stringify(ep)).not.toContain("hidden");
    const list = await (await app.request("/api/endpoints")).text();
    expect(list).not.toContain("hidden");
    expect(await (await app.request("/api/endpoints/test/secret")).json()).toEqual({ signatureSecret: "hidden" });
  });
});

describe("custom signature payload", () => {
  test("signs a timestamp header together with the body", async () => {
    await createEndpoint();
    await patch("test", {
      signatureScheme: "custom",
      signatureSecret: "k",
      signatureCustom: { header: "X-Sig", algorithm: "sha256", encoding: "hex", payload: "v1:{header:X-Ts}:{body}" },
    });
    const sig = createHmac("sha256", "k").update("v1:123:hello").digest("hex");
    await app.request("/hook/test", { method: "POST", headers: { "x-sig": sig, "x-ts": "123" }, body: "hello" });
    let [summary] = await listRequests();
    expect((await getRequest(summary!.id)).signature).toMatchObject({ valid: true });

    await Bun.sleep(2);
    await app.request("/hook/test", { method: "POST", headers: { "x-sig": sig }, body: "hello" });
    [summary] = await listRequests();
    expect((await getRequest(summary!.id)).signature!.message).toBe("Missing X-Ts header");
  });
});

describe("signed sends", () => {
  test("signs outgoing requests so the receiver can verify them", async () => {
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      await createEndpoint();
      const custom = { header: "X-Sig", algorithm: "sha512", encoding: "base64", payload: "{header:X-Ts}.{body}" };
      for (const scheme of ["github", "stripe", "shopify", "slack", "standard", "custom"]) {
        const secret = scheme === "standard" ? `whsec_${btoa("key")}` : "s3cret";
        await patch("test", { signatureScheme: scheme, signatureSecret: secret, signatureCustom: custom });
        await Bun.sleep(2);
        const sent = (await (
          await app.request(
            "/api/send",
            json({
              method: "POST",
              url: `http://localhost:${server.port}/hook/test`,
              headers: [["X-Ts", "42"]],
              body: '{"a":1}',
              sign: { scheme, secret, custom },
            }),
          )
        ).json()) as SentRequest;
        expect(sent.status).toBe(200);
        const [summary] = await listRequests();
        expect({ scheme, ...(await getRequest(summary!.id)).signature }).toMatchObject({ scheme, valid: true });
      }
    } finally {
      server.stop(true);
    }
  });

  test("reports a missing payload header", async () => {
    const res = await app.request(
      "/api/send",
      json({
        url: "http://127.0.0.1:1/",
        headers: [],
        body: "",
        sign: { scheme: "custom", secret: "k", custom: { header: "X-Sig", payload: "{header:X-Ts}" } },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("saved requests and variables", () => {
  const request = { method: "post", url: "{{base}}/x", headers: [["A", "1"]], body: "{}", auth: { type: "bearer", token: "t" } };

  test("creates, lists, updates and deletes saved requests", async () => {
    const created = await app.request("/api/saved", json({ collection: "Shop", name: "Order", request }));
    expect(created.status).toBe(201);
    const saved = (await created.json()) as { id: string; request: { method: string; auth: { type: string; in: string } } };
    expect(saved.request.method).toBe("POST");
    expect(saved.request.auth).toMatchObject({ type: "bearer", in: "header" });

    await app.request(`/api/saved/${saved.id}`, { method: "PUT", body: JSON.stringify({ name: "Order 2" }) });
    const list = (await (await app.request("/api/saved")).json()) as { name: string; collection: string }[];
    expect(list).toMatchObject([{ name: "Order 2", collection: "Shop" }]);

    await app.request(`/api/saved/${saved.id}`, { method: "DELETE" });
    expect(await (await app.request("/api/saved")).json()).toEqual([]);
    expect((await app.request("/api/saved", json({ name: "", request }))).status).toBe(400);
  });

  test("stores variables in order", async () => {
    const put = (body: unknown) => app.request("/api/variables", { method: "PUT", body: JSON.stringify(body) });
    expect(await (await put([["base", "http://x"], ["", "dropped"], ["token", "t"]])).json()).toEqual([
      ["base", "http://x"],
      ["token", "t"],
    ]);
    expect(await (await app.request("/api/variables")).json()).toEqual([
      ["base", "http://x"],
      ["token", "t"],
    ]);
    expect((await put({ a: 1 })).status).toBe(400);
  });
});

describe("tunnel", () => {
  const fake = () => {
    const started: string[] = [];
    let current: string | null = null;
    return {
      started,
      port: 8081,
      providers: () => ["ngrok", "cloudflared", "cloudflared-domain"],
      state: () => (current ? { provider: current, status: "up" as const, url: "https://a.example", error: null } : null),
      start: (name: string) => {
        if (!["ngrok", "cloudflared", "cloudflared-domain"].includes(name)) return false;
        started.push(name);
        current = name;
        return true;
      },
      stop: () => void (current = null),
    };
  };
  const put = (a: ReturnType<typeof createApp>, body: unknown) =>
    a.request("/api/tunnel", { method: "PUT", body: JSON.stringify(body) });

  test("reports no providers when tunnels are off", async () => {
    expect(await (await app.request("/api/tunnel")).json()).toEqual({
      state: null,
      providers: [],
      proxyPort: 0,
      domain: { hostname: "", tokenSet: false },
    });
    expect((await put(app, { provider: "ngrok" })).status).toBe(400);
  });

  test("starts, switches and stops the tunnel, and remembers the choice", async () => {
    const tunnel = fake();
    const tunneled = createApp(store, createHub(), { ...config, tunnel });
    const started = (await (await put(tunneled, { provider: "ngrok" })).json()) as { state: { provider: string } };
    expect(started.state.provider).toBe("ngrok");
    expect(store.getTunnelProvider()).toBe("ngrok");

    await put(tunneled, { provider: "cloudflared" });
    expect(tunnel.started).toEqual(["ngrok", "cloudflared"]);

    expect(((await (await put(tunneled, { provider: "" })).json()) as { state: unknown }).state).toBeNull();
    expect(store.getTunnelProvider()).toBe("");
  });

  test("rejects an unknown provider and a non-string value", async () => {
    const tunneled = createApp(store, createHub(), { ...config, tunnel: fake() });
    expect((await put(tunneled, { provider: "rm -rf" })).status).toBe(400);
    expect((await put(tunneled, { provider: 1 })).status).toBe(400);
    expect(store.getTunnelProvider()).toBe("");
  });
});

describe("tunnel domain", () => {
  const token = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQ";
  const withTunnel = () => {
    let current: string | null = null;
    const tunnel = {
      port: 8081,
      providers: () => ["ngrok", "cloudflared", "cloudflared-domain"],
      state: () => (current ? { provider: current, status: "up" as const, url: "https://a.example", error: null } : null),
      start: (name: string) => ((current = name), true),
      stop: () => void (current = null),
    };
    return { tunnel, tunneled: createApp(store, createHub(), { ...config, tunnel }) };
  };
  const putDomain = (a: ReturnType<typeof createApp>, body: unknown) =>
    a.request("/api/tunnel/domain", { method: "PUT", body: JSON.stringify(body) });
  const info = async (res: Response) =>
    (await res.json()) as { domain: { hostname: string; tokenSet: boolean }; proxyPort: number; state: unknown };

  test("saves the hostname and token, and never returns the token", async () => {
    const { tunneled } = withTunnel();
    const res = await putDomain(tunneled, { hostname: "https://Hook.Example.com/", token });
    const body = await info(res);
    expect(body.domain).toEqual({ hostname: "hook.example.com", tokenSet: true });
    expect(body.proxyPort).toBe(8081);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(store.getTunnelDomain()).toEqual({ hostname: "hook.example.com", token });
  });

  test("keeps the saved token when only the hostname changes", async () => {
    const { tunneled } = withTunnel();
    await putDomain(tunneled, { hostname: "a.example.com", token });
    expect((await putDomain(tunneled, { hostname: "b.example.com" })).status).toBe(200);
    expect(store.getTunnelDomain()).toEqual({ hostname: "b.example.com", token });
  });

  test("rejects a bad hostname, a missing token and a bad token", async () => {
    const { tunneled } = withTunnel();
    for (const hostname of ["nope", "a b.example.com", "x.example.com/path", "-a.example.com"]) {
      expect([hostname, (await putDomain(tunneled, { hostname, token })).status]).toEqual([hostname, 400]);
    }
    expect((await putDomain(tunneled, { hostname: "a.example.com" })).status).toBe(400);
    expect((await putDomain(tunneled, { hostname: "a.example.com", token: "bad token!" })).status).toBe(400);
    expect(store.getTunnelDomain()).toBeNull();
  });

  test("restarts a running own-domain tunnel when saved, and stops it when removed", async () => {
    const { tunnel, tunneled } = withTunnel();
    await putDomain(tunneled, { hostname: "a.example.com", token });
    tunnel.start("cloudflared-domain");
    await putDomain(tunneled, { hostname: "b.example.com" });
    expect(tunnel.state()?.provider).toBe("cloudflared-domain");
    store.setTunnelProvider("cloudflared-domain");

    const removed = await info(await putDomain(tunneled, { hostname: "" }));
    expect(removed.state).toBeNull();
    expect(removed.domain).toEqual({ hostname: "", tokenSet: false });
    expect(store.getTunnelProvider()).toBe("");
  });
});
