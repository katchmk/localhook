import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import { openStore } from "./db";
import { createHub } from "./hub";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const port = env("PORT", 8080);
const hostname = process.env.HOST || undefined;
const dataDir = process.env.DATA_DIR ?? "./data";
const maxBodyBytes = env("MAX_BODY_BYTES", 10 * 1024 * 1024);

mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, "localhook.db"));

const app = createApp(store, createHub(), {
  maxBodyBytes,
  maxRequestsPerEndpoint: env("MAX_REQUESTS_PER_ENDPOINT", 500),
  maxSent: env("MAX_SENT", 200),
  sendTimeoutMs: env("SEND_TIMEOUT_MS", 30_000),
  staticDir: process.env.NODE_ENV === "production" ? (process.env.STATIC_DIR ?? "./dist") : undefined,
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
