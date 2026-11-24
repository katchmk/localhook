import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import { openStore } from "./db";
import { createHub } from "./hub";
import { startHookProxy } from "./hookProxy";
import { createTunnelManager } from "./tunnel";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const port = env("PORT", 8080);
const hostname = process.env.HOST || undefined;
const dataDir = process.env.DATA_DIR ?? "./data";
const maxBodyBytes = env("MAX_BODY_BYTES", 10 * 1024 * 1024);
const authPassword = process.env.AUTH_PASSWORD;

mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, "localhook.db"));

const tunnelCommand = process.env.TUNNEL_COMMAND?.trim() || undefined;
// Tunnels point at this proxy, not at the main server, so only /hook is public.
// Its port stays the same between runs, so a Cloudflare public hostname can point at it.
const hookProxy = startHookProxy(`http://${hostname ?? "127.0.0.1"}:${port}`, maxBodyBytes, env("HOOK_PROXY_PORT", port + 1));
const tunnel = createTunnelManager(hookProxy.port!, { customCommand: tunnelCommand, domain: store.getTunnelDomain });
// Start again the provider that was picked in the UI. A saved "custom" needs TUNNEL_COMMAND to be set.
const tunnelName = store.getTunnelProvider();
if (tunnelName && !tunnel.start(tunnelName)) {
  console.error(`Saved tunnel "${tunnelName}" is not available. Use one of: ${tunnel.providers().join(", ")}.`);
}
process.on("exit", () => tunnel.stop());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

const app = createApp(store, createHub(), {
  maxBodyBytes,
  maxRequestsPerEndpoint: env("MAX_REQUESTS_PER_ENDPOINT", 500),
  maxSent: env("MAX_SENT", 200),
  sendTimeoutMs: env("SEND_TIMEOUT_MS", 30_000),
  staticDir: process.env.NODE_ENV === "production" ? (process.env.STATIC_DIR ?? "./dist") : undefined,
  tunnel,
  auth: authPassword ? { username: process.env.AUTH_USERNAME || "admin", password: authPassword } : undefined,
});

const server = Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
  // Leave headroom so the app can answer 413 itself instead of Bun dropping the connection.
  maxRequestBodySize: maxBodyBytes + 1024 * 1024,
  // SSE connections stay open; disable Bun's idle timeout (default 10s).
  idleTimeout: 0,
});

console.log(`localhook listening on ${server.url}`);

if (tunnel.state()) {
  // Log the public URL once, as soon as the provider prints it.
  const timer = setInterval(() => {
    const { status, url, error } = tunnel.state() ?? { status: "stopped", url: null, error: null };
    if (status === "starting") return;
    clearInterval(timer);
    console.log(status === "up" ? `tunnel (${tunnelName}): ${url}/hook/<endpoint id>` : `tunnel: ${error ?? status}`);
  }, 250);
}
