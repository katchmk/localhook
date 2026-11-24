# ---- Build the web UI ----
# dist/ is the same on every CPU, so build it natively, not under emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- Tunnel CLIs (static binaries) for the optional public hook URL ----
FROM alpine:3.22 AS tunnels
ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.11.2
RUN apk add --no-cache curl \
 && curl -fsSL -o /cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}" \
 && chmod +x /cloudflared \
 && curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${TARGETARCH}.tgz" | tar -xz -C / ngrok

# ---- Runtime: Bun serves the API, the webhook receiver and the built UI ----
FROM oven/bun:1.4.4-alpine
RUN apk add --no-cache ca-certificates
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=tunnels /cloudflared /ngrok /usr/local/bin/
COPY server ./server
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:${PORT}/api/endpoints > /dev/null || exit 1
CMD ["bun", "server/index.ts"]
