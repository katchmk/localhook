/** localhook probes its own public URL on this path to learn when the tunnel works. */
export const PING_PATH = "/.localhook-ping";

/**
 * A small server that tunnels point at instead of the main server. It forwards only /hook
 * requests, so the UI and the API stay private. Everything else gets 404, except PING_PATH.
 */
export function startHookProxy(targetOrigin: string, maxBodyBytes: number, preferredPort = 0) {
  // A tunnel for the user's own domain needs the same port every time, so try the preferred port first.
  try {
    return serveHookProxy(targetOrigin, maxBodyBytes, preferredPort);
  } catch (e) {
    if (preferredPort === 0) throw e;
    console.warn(`Hook proxy port ${preferredPort} is in use; using a free port. Set HOOK_PROXY_PORT to change it.`);
    return serveHookProxy(targetOrigin, maxBodyBytes, 0);
  }
}

function serveHookProxy(targetOrigin: string, maxBodyBytes: number, port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    maxRequestBodySize: maxBodyBytes + 1024 * 1024,
    // Hooks can be slow on purpose (response delay, proxy mode). 255 s is Bun's maximum.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === PING_PATH) return new Response("ok");
      if (url.pathname !== "/hook" && !url.pathname.startsWith("/hook/")) {
        return new Response("Not found", { status: 404 });
      }
      try {
        // The body is read as a whole so that the stored bytes stay exactly what the sender sent.
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        return await fetch(`${targetOrigin}${url.pathname}${url.search}`, {
          method: req.method,
          headers: req.headers, // Includes the original Host and X-Forwarded-For.
          body: hasBody ? await req.arrayBuffer() : undefined,
          redirect: "manual",
        });
      } catch {
        return new Response("localhook is not reachable", { status: 502 });
      }
    },
  });
}
