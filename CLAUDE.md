# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun is pinned in `mise.toml`; if `bun` is not on PATH, prefix commands with `mise exec --`.

```sh
bun install
bun run dev                      # server on :8080 (bun --watch) + Vite on :5173, proxying /api and /hook
bun test                         # all tests (server/app.test.ts, web/src/parsers.test.ts)
bun test -t "keeps only"         # single test by name
bun run typecheck                # tsc --noEmit over server/ and web/src/
bun run build                    # Vite build of web/ into dist/
docker compose up -d --build     # production container on :8080, data in volume localhook-data
```

The Docker container and `bun run dev` both bind port 8080; stop one before starting the other.

## Architecture

One Bun process serves three things on one port (see `server/app.ts`):

1. **Webhook receiver** — `app.all("/hook/:id")` and `/hook/:id/*` capture any method. The raw body is stored as a BLOB (never parsed) so signature checks on replay stay valid. The subpath after `/hook/<id>` and the query string are stored separately. Each endpoint returns its own configurable status/content type/body/delay, or the first matching `responseRules` entry (`pickResponse`). With `forwardUrl` set, the request is also sent there; the result is saved in `requests.forward` and published again through the hub. `forwardMode: "async"` does not wait; `"proxy"` waits and returns the target's response (`sendRaw`), unless a rule matches. The `X-Localhook-Hops` header stops forward loops after `MAX_HOPS`.
2. **JSON API** under `/api` — endpoints CRUD, captured requests, export, SSE stream, sender, replay.
3. **Static UI** — only when `NODE_ENV=production` (serves `dist/`, SPA fallback to `index.html`). In dev, Vite serves the UI.

Key flows that span files:

- **Live updates**: `capture` → `store.insertRequest` → `hub.publish` (`server/hub.ts`, in-memory per-endpoint listeners) → `GET /api/endpoints/:id/stream` (Hono `streamSSE`, events `ready`/`request`/`ping`) → `EventSource` in `web/src/Receiver.tsx`. SSE only pushes summaries; the UI fetches full detail via `GET /api/requests/:id`. `Bun.serve` uses `idleTimeout: 0` so SSE connections are not dropped.
- **Sending**: the browser never calls targets directly. `POST /api/send` and `POST /api/requests/:id/replay` both go through `server/send.ts` (`redirect: "manual"`, hop-by-hop headers stripped, timeout), and every result is saved to the `sent` table, which is the Sender history.
- **Storage**: `server/db.ts` wraps `bun:sqlite` and maps snake_case rows to the camelCase types in `server/types.ts`. Retention (per-endpoint request cap, sender history cap) is enforced on insert. Bodies that are not valid UTF-8 are returned as base64 with `bodyEncoding: "base64"`. Headers are stored as ordered `[name, value]` pairs to keep duplicates.
- **Signatures**: `server/signature.ts` checks the raw body against the endpoint's scheme and secret when `GET /api/requests/:id` is read; the result is not stored. `signRequest` signs Sender requests (`SendInput.sign`) on the server. The secret is not part of `Endpoint`; only `store.getSignatureSecret` and `GET /api/endpoints/:id/secret` return it.
- **Sender**: `web/src/senderDraft.ts` holds the editor model and its conversions (captured, history, saved, cURL). `{{variables}}` and auth are applied in the browser by `toSendInput`; the signature is added by the server. Saved requests (`saved_requests` table) and variables (`settings` table) are under `/api/saved` and `/api/variables`.
- **Import/export**: `server/transfer.ts` builds HAR and parses a localhook JSON export or a HAR file into new requests (new ids).
- **Auth**: with `config.auth`, Hono `basicAuth` guards everything except `/hook`.
- **Shared types**: `server/types.ts` is imported by the web UI through `web/src/api.ts` (`export type *`); change types there.
- **Config**: env vars are read only in `server/index.ts` and passed to `createApp(store, hub, config)`. Tests build the app with `openStore(":memory:")` and call `app.request()`; `getConnInfo` throws there, so `clientIp` falls back to `null`.

UI: React 19 + Tailwind v4 (via `@tailwindcss/vite`, no config file), dark-only. Hash routing in `web/src/App.tsx` (`#/receiver/<endpointId>`, `#/sender`, `#/sender/<capturedRequestId>` to load a captured request into the Sender). Shared primitives (buttons, badges, tabs, CodeMirror `CodeView`, formatting helpers) live in `web/src/ui.tsx`; these are hand-written, not shadcn/ui.

## Docker

Multi-stage `Dockerfile`: the build stage runs `bun run build`; the runtime stage installs production deps only (just `hono`), copies `server/` and `dist/`, and runs as the `bun` user with `DATA_DIR=/data`. `compose.yaml` adds `host.docker.internal:host-gateway` so the Sender can reach host services on Linux too.
