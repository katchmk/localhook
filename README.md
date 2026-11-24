# localhook

A local webhook receiver and sender in one Docker container.

- **Receiver**: create endpoints, send any HTTP method to `/hook/<id>/...`, and inspect each request (headers, query, body, raw JSON) live in the browser. Replay a captured request to another URL.
  - **Auto-forward**: send each captured request to your app as well, with its subpath and query. In **proxy mode**, the sender gets your app's response, so handshakes such as the Slack URL challenge work. Forwards stop after 5 hops (`X-Localhook-Hops` header), so endpoints that forward to each other cannot loop.
  - **Signature check**: verify GitHub, Stripe, Shopify, Slack and Standard Webhooks (Svix) signatures, or a custom HMAC header (SHA-256, SHA-1 or SHA-512, hex or base64) over a payload such as `{header:X-Timestamp}.{body}`. The API returns the secret only on request.
  - **Response rules**: return a different status, body or delay for each method and subpath, e.g. to test retries and timeouts.
  - **Search** by method and by text in the path, headers and body. **Compare** two requests line by line.
  - **Multipart bodies** show as fields and files, with a download for each file.
  - **Import and export** as localhook JSON or HAR.
  - **Copy as cURL**, or open a request in the Sender to change it and send it again.
- **Sender**: send HTTP requests from the server (no CORS limits) and keep a history of responses.
  - **Auth**: Basic, Bearer token or API key (header or query).
  - **Signature**: sign the request like a webhook provider (all schemes above), to test your own signature checks.
  - **Saved requests** in named collections, and **variables** such as `{{baseUrl}}` or `{{token}}`.
  - **Import a cURL command** into the editor, or copy the request as cURL.

![Receiver: captured requests and request details](docs/receiver.png)

![Sender: request editor and history](docs/sender.png)

## Run with Docker

With the repo checked out:

```sh
docker compose up -d            # pulls katchmk/localhook:latest
docker compose up -d --build    # or builds from source
```

Without the repo:

```sh
docker run -d --name localhook -p 8080:8080 -v localhook-data:/data \
  --add-host host.docker.internal:host-gateway katchmk/localhook:latest
```

Open http://localhost:8080. Data is kept in the `localhook-data` volume.

Images are built for `linux/amd64` and `linux/arm64`. Only a release tag `v1.2.3` builds an image. It gets the tags `1.2.3`, `1.2`, `1`, `latest` and `sha-<commit>`.

Send a webhook:

```sh
curl -X POST http://localhost:8080/hook/<endpoint-id>/orders -H 'content-type: application/json' -d '{"hello":"world"}'
```

Inside the container, `localhost` is the container itself. To send to a service on your computer, use `host.docker.internal`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Server port (API, webhooks and built UI). With Docker, the host port. In dev, also the Vite proxy target |
| `HOST` | all interfaces | Server bind address, for example `127.0.0.1` |
| `WEB_PORT` | `5173` | Vite dev server port (`bun run dev` only) |
| `WEB_HOST` | `localhost` | Vite dev server bind address (`bun run dev` only) |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite database directory |
| `MAX_BODY_BYTES` | `10485760` | Maximum captured or response body size |
| `MAX_REQUESTS_PER_ENDPOINT` | `500` | Older captured requests are deleted |
| `MAX_SENT` | `200` | Sender history size |
| `SEND_TIMEOUT_MS` | `30000` | Timeout for sent, replayed and forwarded requests |
| `AUTH_PASSWORD` | none | Turns on HTTP Basic auth for the UI and API. Webhook URLs (`/hook/...`) stay open |
| `AUTH_USERNAME` | `admin` | Basic auth user name |
| `HOOK_PROXY_PORT` | `PORT` + 1 | Local port of the hook-only proxy that tunnels expose. A Cloudflare public hostname for your own domain points at this port. If the port is in use, a free port is used |
| `TUNNEL_COMMAND` | none | Adds a `custom` provider that runs this command. `{port}` is replaced with the port of the hook-only proxy. Only the environment can set it, never the UI or API |

### Tunnels

Pick a provider in the Receiver (the list under the webhook URL). localhook starts the provider's CLI and shows the public webhook URL. The choice is saved and starts again at the next boot. The CLI must be installed and signed in (ngrok needs an auth token) on the machine that runs localhook.

| Provider | Command that runs |
|---|---|
| `ngrok` | `ngrok http <proxy port>` |
| `cloudflared` | `cloudflared tunnel --url http://localhost:<proxy port>` (quick tunnel, no account) |
| `custom` | `TUNNEL_COMMAND` (only listed when the variable is set). The first `https://` URL in its output is the public URL. Example: `TUNNEL_COMMAND="cloudflared tunnel --url http://localhost:{port}"` |

#### Your own domain with cloudflared

Quick tunnels get a new random URL each time. To get a fixed URL on your own domain, use a named Cloudflare tunnel. This needs a free Cloudflare account and a domain on Cloudflare.

1. In Cloudflare Zero Trust, open Networks → Tunnels. Create a tunnel of type cloudflared and copy its token.
2. Add a public hostname to the tunnel, for example `hook.example.com`. Set the service to `HTTP` and `localhost:8081` (`HOOK_PROXY_PORT`; the Receiver shows the port).
3. In the Receiver, click the globe button next to the tunnel list. Enter the hostname and the token, and click Save and start.

The token is saved in the database and is never sent back to the browser. It is given to `cloudflared` in an environment variable, not in its arguments. Use `cloudflared (own domain)` in the tunnel list to start it again later. This also works in Docker, because `cloudflared` runs in the same container.

The tunnel exposes only `/hook` URLs. The UI and the API (`/api`) are not reachable through it and return 404. The Docker image includes `cloudflared` and `ngrok`. For ngrok, set `NGROK_AUTHTOKEN` in the container environment. `cloudflared` quick tunnels need no account.

Set variables in the shell or in a `.env` file in the project root (see `.env.example`). Bun, Vite and Docker Compose all read it.

## Development

Requires [Bun](https://bun.sh) (pinned in `mise.toml`).

```sh
bun install
bun run dev        # API on :$PORT (watch mode) + Vite UI on :$WEB_PORT
bun test           # server tests
bun run typecheck
bun run build      # builds the UI into dist/
```

Stop the container first, or it holds port 8080 (or set a different `PORT`).
