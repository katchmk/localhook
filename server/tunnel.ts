import { PING_PATH } from "./hookProxy";
import { DOMAIN_PROVIDER, type TunnelState } from "./types";

/**
 * A tunnel provider is an external CLI that exposes a local port on a public URL.
 * localhook starts the CLI as a child process and reads the public URL from its output.
 */
export interface TunnelProvider {
  /** The argument list to start the tunnel for a local port. */
  command(port: number): string[];
  /** The public URL in one line of output, or null if the line has none. */
  parseUrl(line: string): string | null;
  /** Shown when the command is not installed. */
  installHint: string;
  /** Extra environment variables for the command, for secrets that must not be in the argument list. */
  env?: Record<string, string>;
  /** Added to the error when the public URL never answers. */
  unreachableHint?: string;
}

const firstMatch = (re: RegExp) => (line: string) => re.exec(line)?.[0] ?? null;
const anyHttpsUrl = firstMatch(/https:\/\/[^\s"'<>]+/);

export const PROVIDERS: Record<string, TunnelProvider> = {
  ngrok: {
    command: (port) => ["ngrok", "http", String(port), "--log=stdout", "--log-format=logfmt"],
    // The line `msg="started tunnel" ... url=https://abc.ngrok-free.app`. Other lines can have a url= too.
    parseUrl: (line) => (line.includes("started tunnel") ? /url=(https:\/\/[^\s"]+)/.exec(line)?.[1] ?? null : null),
    installHint: "Install ngrok and run `ngrok config add-authtoken <token>`.",
  },
  cloudflared: {
    command: (port) => ["cloudflared", "tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
    parseUrl: firstMatch(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/),
    installHint: "Install cloudflared (for example `brew install cloudflared`).",
  },
};

/** The "custom" provider: `TUNNEL_COMMAND` gives the command. `{port}` is replaced and the first https URL in the output is used. */
export function customProvider(template: string): TunnelProvider {
  return {
    command: (port) =>
      template
        .trim()
        .split(/\s+/)
        .map((part) => part.replaceAll("{port}", String(port))),
    parseUrl: anyHttpsUrl,
    installHint: "Check that TUNNEL_COMMAND is correct and that its program is installed.",
  };
}

export interface DomainConfig {
  hostname: string;
  token: string;
}

/**
 * A named cloudflared tunnel on the user's own domain. The token comes from the Cloudflare dashboard.
 * The dashboard sets which hostname goes to which local service, so its service must be http://localhost:<port>.
 */
export function domainProvider({ hostname, token }: DomainConfig, port: number): TunnelProvider {
  return {
    command: () => ["cloudflared", "tunnel", "--no-autoupdate", "run"],
    env: { TUNNEL_TOKEN: token }, // Not in the argument list, where other users could read it with `ps`.
    // The hostname is known already. The tunnel is ready for a test when cloudflared has connected.
    parseUrl: (line) => (line.includes("Registered tunnel connection") ? `https://${hostname}` : null),
    installHint: "Install cloudflared (for example `brew install cloudflared`).",
    unreachableHint: `Check in Cloudflare that the public hostname ${hostname} uses the service http://localhost:${port}`,
  };
}

export interface Tunnel {
  state(): TunnelState;
  stop(): void;
}

const LOG_LINES = 8;

/** True when a request through the public URL reaches localhook's hook proxy. */
export async function probeUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}${PING_PATH}`, {
      signal: AbortSignal.timeout(5000),
      redirect: "manual",
      headers: { "ngrok-skip-browser-warning": "1" }, // ngrok's free plan can show a warning page instead.
    });
    return res.status === 200 && (await res.text()) === "ok";
  } catch {
    return false; // For example a DNS name that does not exist yet.
  }
}

export interface ReadyOptions {
  probe: (url: string) => Promise<boolean>;
  intervalMs: number;
  timeoutMs: number;
}

// Some providers print the URL before it works. Cloudflare quick tunnels can need over a minute for DNS.
const DEFAULT_READY: ReadyOptions = { probe: probeUrl, intervalMs: 2000, timeoutMs: 180_000 };

/**
 * Starts the provider command and tracks its public URL. The state stays "starting" until a request
 * through the URL works, so the UI never shows a URL that does not work yet. Never throws; failures are in `state()`. */
export function startTunnel(
  name: string,
  provider: TunnelProvider,
  port: number,
  ready: ReadyOptions = DEFAULT_READY,
): Tunnel {
  let state: TunnelState = { provider: name, status: "starting", url: null, error: null };
  const tail: string[] = [];
  let stopped = false;

  let found = false;

  const waitUntilReachable = async (url: string) => {
    const deadline = Date.now() + ready.timeoutMs;
    while (!stopped && state.status === "starting" && Date.now() < deadline) {
      if (await ready.probe(url)) {
        if (!stopped && state.status === "starting") state = { provider: name, status: "up", url, error: null };
        return;
      }
      await Bun.sleep(ready.intervalMs);
    }
    if (state.status === "starting") {
      fail(`${url} did not become reachable in ${Math.round(ready.timeoutMs / 1000)} seconds. ${provider.unreachableHint ?? "Check your network and DNS"}, then pick the tunnel again.`);
    }
  };

  const fail = (error: string) => {
    if (!stopped) state = { provider: name, status: "error", url: null, error };
  };

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(provider.command(port), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: provider.env ? { ...process.env, ...provider.env } : undefined,
    });
  } catch {
    fail(`Cannot start "${provider.command(port)[0]}". ${provider.installHint}`);
    return { state: () => state, stop() {} };
  }

  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffer = "";
    const onLine = (line: string) => {
      if (!line.trim()) return;
      tail.push(line);
      if (tail.length > LOG_LINES) tail.shift();
      const url = found ? null : provider.parseUrl(line);
      if (url) {
        found = true;
        void waitUntilReachable(url);
      }
    };
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(onLine);
    }
    onLine(buffer);
  };

  const done = Promise.all([read(proc.stdout), read(proc.stderr)]).catch(() => {});
  void proc.exited.then(async (code) => {
    await done; // Read the last output lines before the error is built.
    if (stopped) return;
    const output = tail.join("\n");
    fail(`${name} stopped (exit code ${code}).${output ? `\n${output}` : ""}`);
  });

  return {
    state: () => state,
    stop() {
      stopped = true;
      state = { provider: name, status: "stopped", url: null, error: null };
      proc.kill();
    },
  };
}

export interface TunnelManager {
  /** The current tunnel, or null when none was started. */
  state(): TunnelState | null;
  /** The names that `start` accepts now. The own-domain provider is there only when it is set up. */
  providers(): string[];
  /** The local port that tunnels expose. */
  port: number;
  /** Stops the current tunnel and starts the named one. Returns false for an unknown name. */
  start(name: string): boolean;
  stop(): void;
}

export interface TunnelManagerOptions {
  /** Adds the "custom" provider. From the environment only: see below. */
  customCommand?: string;
  /** The saved own-domain settings, or null. */
  domain?: () => DomainConfig | null;
}

/**
 * Owns at most one tunnel at a time, so the UI can switch providers while the server runs.
 * `port` is the local port to expose; the caller gives the hook proxy port, so only /hook is public.
 * `customCommand` comes from the environment only. The API never accepts a command, because
 * anyone who can reach the API would then be able to run programs on the host.
 */
export function createTunnelManager(port: number, { customCommand, domain }: TunnelManagerOptions = {}): TunnelManager {
  let current: Tunnel | null = null;
  const providers = () => [
    ...Object.keys(PROVIDERS),
    ...(domain?.() ? [DOMAIN_PROVIDER] : []),
    ...(customCommand ? ["custom"] : []),
  ];
  return {
    port,
    providers,
    state: () => current?.state() ?? null,
    start(name) {
      if (!providers().includes(name)) return false;
      const provider =
        name === "custom" ? customProvider(customCommand!) : name === DOMAIN_PROVIDER ? domainProvider(domain!()!, port) : PROVIDERS[name]!;
      current?.stop();
      current = startTunnel(name, provider, port);
      return true;
    },
    stop() {
      current?.stop();
      current = null;
    },
  };
}
