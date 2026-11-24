import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PING_PATH, startHookProxy } from "./hookProxy";

let target: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof startHookProxy>;

beforeAll(() => {
  target = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      return Response.json({
        method: req.method,
        path: url.pathname + url.search,
        host: req.headers.get("host"),
        body: Buffer.from(await req.arrayBuffer()).toString("hex"),
      });
    },
  });
  proxy = startHookProxy(`http://127.0.0.1:${target.port}`, 1024);
});
afterAll(() => {
  proxy.stop(true);
  target.stop(true);
});

const call = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${proxy.port}${path}`, init);

describe("hook proxy", () => {
  test("forwards /hook requests with method, subpath, query, host and exact body bytes", async () => {
    const res = await call("/hook/abc/orders?x=1", { method: "PUT", headers: { host: "public.example" }, body: new Uint8Array([0, 255, 1]) });
    expect(await res.json()).toEqual({ method: "PUT", path: "/hook/abc/orders?x=1", host: "public.example", body: "00ff01" });
  });

  test("hides everything that is not /hook", async () => {
    for (const path of ["/", "/api/endpoints", "/api/tunnel", "/hookup", "/assets/x.js"]) {
      expect([path, (await call(path)).status]).toEqual([path, 404]);
    }
  });

  test("answers the ping path itself, without the main server", async () => {
    const res = await call(PING_PATH);
    expect([res.status, await res.text()]).toEqual([200, "ok"]);
  });

  test("uses the preferred port, and a free port when it is taken", async () => {
    const first = startHookProxy(`http://127.0.0.1:${target.port}`, 1024, 0);
    const preferred = startHookProxy(`http://127.0.0.1:${target.port}`, 1024, first.port);
    expect(preferred.port).not.toBe(first.port);
    const again = startHookProxy(`http://127.0.0.1:${target.port}`, 1024, preferred.port! + 0);
    expect(again.port).not.toBe(preferred.port);
    for (const server of [first, preferred, again]) server.stop(true);
  });

  test("does not let dot segments reach another path", async () => {
    // The URL parser folds these to /api/endpoints before the proxy checks the path.
    for (const path of ["/hook/../api/endpoints", "/hook/%2e%2e/api/endpoints"]) {
      expect([path, (await call(path)).status]).toEqual([path, 404]);
    }
  });
});
