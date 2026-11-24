import { describe, expect, test } from "bun:test";
import { createTunnelManager, customProvider, domainProvider, PROVIDERS, startTunnel } from "./tunnel";

describe("tunnel providers", () => {
  test("ngrok: reads the url of the started tunnel only", () => {
    const { parseUrl } = PROVIDERS.ngrok!;
    expect(parseUrl('t=1 lvl=info msg="starting web service" obj=web addr=127.0.0.1:4040')).toBeNull();
    expect(
      parseUrl('t=1 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:8080 url=https://ab-12.ngrok-free.app'),
    ).toBe("https://ab-12.ngrok-free.app");
  });

  test("cloudflared: reads the trycloudflare url from the banner", () => {
    const { parseUrl } = PROVIDERS.cloudflared!;
    expect(parseUrl("INF |  https://quiet-fox-123.trycloudflare.com  |")).toBe("https://quiet-fox-123.trycloudflare.com");
    expect(parseUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
  });

  test("custom: replaces {port} and takes the first https url", () => {
    const p = customProvider("bore local {port} --to bore.pub");
    expect(p.command(8080)).toEqual(["bore", "local", "8080", "--to", "bore.pub"]);
    expect(p.parseUrl("listening at https://bore.pub:1234")).toBe("https://bore.pub:1234");
  });
});

describe("startTunnel", () => {
  const quick = (probe: (url: string) => Promise<boolean>, timeoutMs = 2000) => ({ probe, intervalMs: 10, timeoutMs });
  const printsUrl = { ...customProvider("x"), command: () => ["sh", "-c", "echo https://x.example; sleep 5"] };
  const waitFor = async (tunnel: { state(): { status: string } }, status: string) => {
    for (let i = 0; i < 100 && tunnel.state().status !== status; i++) await Bun.sleep(20);
  };

  test("stays starting until the url answers, then goes up", async () => {
    let reachable = false;
    const tunnel = startTunnel("custom", printsUrl, 1, quick(async () => reachable));
    await Bun.sleep(150); // The command has printed its url by now, but the url does not answer yet.
    expect(tunnel.state()).toMatchObject({ status: "starting", url: null });
    reachable = true;
    await waitFor(tunnel, "up");
    expect(tunnel.state()).toMatchObject({ status: "up", url: "https://x.example" });
    tunnel.stop();
    expect(tunnel.state().status).toBe("stopped");
  });

  test("reports an error when the url never answers", async () => {
    const tunnel = startTunnel("custom", printsUrl, 1, quick(async () => false, 100));
    await waitFor(tunnel, "error");
    expect(tunnel.state().error).toContain("did not become reachable");
    tunnel.stop();
  });

  test("reports an error when the command is missing or exits", async () => {
    const missing = startTunnel("custom", customProvider("definitely-not-installed-xyz {port}"), 1);
    expect(missing.state().status).toBe("error");
    const exits = startTunnel("custom", { ...customProvider("x"), command: () => ["sh", "-c", "echo boom; exit 3"] }, 1);
    for (let i = 0; i < 40 && exits.state().status === "starting"; i++) await Bun.sleep(25);
    expect(exits.state().error).toContain("exit code 3");
    expect(exits.state().error).toContain("boom");
  });
});

describe("createTunnelManager", () => {
  test("offers custom only when a command is set, and rejects unknown names", () => {
    expect(createTunnelManager(1).providers()).toEqual(["ngrok", "cloudflared"]);
    const manager = createTunnelManager(1, { customCommand: "sh -c 'echo hi'" });
    expect(manager.providers()).toContain("custom");
    expect(createTunnelManager(1).start("custom")).toBe(false);
    expect(manager.start("nope")).toBe(false);
    expect(manager.state()).toBeNull();
  });

  test("a new start replaces the running tunnel", () => {
    const manager = createTunnelManager(1, { customCommand: "definitely-not-installed-xyz {port}" });
    expect(manager.start("custom")).toBe(true);
    expect(manager.state()?.provider).toBe("custom");
    manager.stop();
    expect(manager.state()).toBeNull();
  });
});

describe("own domain provider", () => {
  const config = { hostname: "hook.example.com", token: "eyJhIjoiYWNjb3VudCJ9" };

  test("keeps the token out of the arguments and gives the url once cloudflared has connected", () => {
    const p = domainProvider(config, 8081);
    expect(p.command(8081).join(" ")).not.toContain(config.token);
    expect(p.env).toEqual({ TUNNEL_TOKEN: config.token });
    expect(p.parseUrl("INF Starting tunnel tunnelID=abc")).toBeNull();
    expect(p.parseUrl("INF Registered tunnel connection connIndex=0 location=ams23")).toBe("https://hook.example.com");
    expect(p.unreachableHint).toContain("http://localhost:8081");
  });

  test("is offered only when the settings exist", () => {
    let saved: typeof config | null = null;
    const manager = createTunnelManager(8081, { domain: () => saved });
    expect(manager.providers()).not.toContain("cloudflared-domain");
    expect(manager.start("cloudflared-domain")).toBe(false);
    saved = config;
    expect(manager.providers()).toContain("cloudflared-domain");
  });

  test("passes the token to the process through the environment", async () => {
    const provider = {
      ...domainProvider(config, 1),
      command: () => ["sh", "-c", 'echo "Registered tunnel connection $TUNNEL_TOKEN"; sleep 5'],
      parseUrl: (line: string) => (line.includes(config.token) ? "https://ok.example" : null),
    };
    const tunnel = startTunnel("cloudflared-domain", provider, 1, { probe: async () => true, intervalMs: 10, timeoutMs: 1000 });
    for (let i = 0; i < 100 && tunnel.state().status !== "up"; i++) await Bun.sleep(20);
    expect(tunnel.state().url).toBe("https://ok.example");
    tunnel.stop();
  });
});
