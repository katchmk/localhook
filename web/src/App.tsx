import { Send, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { Receiver } from "./Receiver";
import { Sender } from "./Sender";
import { cx } from "./ui";

const REPO_URL = "https://github.com/katchmk/localhook";

// lucide-react v1 has no brand icons
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

// Routes: #/receiver/<endpointId> and #/sender
function parseHash() {
  const [, view, id] = window.location.hash.split("/");
  return { view: view === "sender" ? "sender" : "receiver", endpointId: id ?? null } as const;
}

export function App() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center gap-2 font-mono text-sm font-semibold">
          <Webhook className="size-5 text-sky-400" />
          localhook
        </div>
        <nav className="flex gap-1">
          {(
            [
              { view: "receiver", href: "#/receiver", label: "Receiver", Icon: Webhook },
              { view: "sender", href: "#/sender", label: "Sender", Icon: Send },
            ] as const
          ).map(({ view, href, label, Icon }) => (
            <a
              key={view}
              href={href}
              className={cx(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                route.view === view ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-100",
              )}
            >
              <Icon className="size-4" />
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <span className="hidden text-xs text-zinc-500 lg:inline">
            Self-hosted webhook receiver and sender
          </span>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-100"
          >
            <GitHubIcon className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>
      </header>
      <main className="min-h-0 flex-1 p-4 md:p-6">
        {route.view === "sender" ? <Sender /> : <Receiver endpointId={route.endpointId} />}
      </main>
    </div>
  );
}
