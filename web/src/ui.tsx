import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { githubDark } from "@uiw/codemirror-theme-github";
import CodeMirror from "@uiw/react-codemirror";
import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { HeaderPair } from "./api";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
}) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-sky-500 disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "h-8 px-3 text-sm",
        size === "md" && "h-10 px-4 text-sm",
        size === "icon" && "size-8",
        variant === "primary" && "bg-sky-500 text-zinc-950 hover:bg-sky-400",
        variant === "secondary" && "border border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800",
        variant === "ghost" && "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
        variant === "danger" && "text-rose-400 hover:bg-rose-500/10 hover:text-rose-300",
        className,
      )}
    />
  );
}

const METHOD_COLORS: Record<string, string> = {
  GET: "border-sky-500/40 bg-sky-500/10 text-sky-400",
  POST: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  PUT: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  PATCH: "border-violet-500/40 bg-violet-500/10 text-violet-400",
  DELETE: "border-rose-500/40 bg-rose-500/10 text-rose-400",
};

export function MethodBadge({ method, large }: { method: string; large?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded border font-mono font-semibold",
        large ? "px-3 py-1 text-sm" : "px-1.5 py-0.5 text-[11px]",
        METHOD_COLORS[method] ?? "border-zinc-600 bg-zinc-800 text-zinc-300",
      )}
    >
      {method}
    </span>
  );
}

export function StatusBadge({ status, error }: { status: number | null; error?: string | null }) {
  const color =
    status === null
      ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
      : status < 300
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
        : status < 400
          ? "border-sky-500/40 bg-sky-500/10 text-sky-400"
          : status < 500
            ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
            : "border-rose-500/40 bg-rose-500/10 text-rose-400";
  return (
    <span className={cx("rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold", color)} title={error ?? undefined}>
      {status ?? "ERR"}
    </span>
  );
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant={label ? "secondary" : "ghost"}
      size={label ? "sm" : "icon"}
      className={className}
      title="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
      {label}
    </Button>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-zinc-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors",
            value === t.id ? "border-sky-500 text-sky-400" : "border-transparent text-zinc-400 hover:text-zinc-200",
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="rounded-full bg-zinc-800 px-1.5 text-[11px] text-zinc-300">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

const isCookie = ([name]: HeaderPair) => name.trim().toLowerCase() === "cookie";

// A request can carry several Cookie headers; each holds "name=value" pairs split by ";".
export function parseCookies(headers: HeaderPair[]): HeaderPair[] {
  return headers
    .filter(isCookie)
    .flatMap(([, value]) => value.split(";"))
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? [part, ""] : [part.slice(0, eq).trim(), part.slice(eq + 1).trim()];
    });
}

// Split Cookie headers out of a header list, so cookies can be edited on their own.
export function splitCookies(headers: HeaderPair[]): { headers: HeaderPair[]; cookies: HeaderPair[] } {
  return { headers: headers.filter((h) => !isCookie(h)), cookies: parseCookies(headers) };
}

// The inverse of splitCookies: all cookies go into one Cookie header, because fetch joins
// repeated headers with ", " and a Cookie header must use "; ".
export function joinCookies(headers: HeaderPair[], cookies: HeaderPair[]): HeaderPair[] {
  const pairs = cookies.filter(([k]) => k.trim()).map(([k, v]) => (v ? `${k.trim()}=${v}` : k.trim()));
  return pairs.length ? [...headers, ["Cookie", pairs.join("; ")]] : headers;
}

// Each Set-Cookie header becomes [name, value and attributes].
export function parseSetCookies(headers: HeaderPair[]): HeaderPair[] {
  return headers
    .filter(([name]) => name.toLowerCase() === "set-cookie")
    .map(([, value]) => {
      const eq = value.indexOf("=");
      return eq === -1 ? [value.trim(), ""] : [value.slice(0, eq).trim(), value.slice(eq + 1).trim()];
    });
}

export function KeyValueTable({ rows, empty }: { rows: HeaderPair[]; empty: string }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-zinc-500 italic">{empty}</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800">
      <table className="w-full text-left font-mono text-[13px]">
        <thead className="bg-zinc-900 text-xs text-zinc-400">
          <tr>
            <th className="w-1/3 px-4 py-2 font-medium">Key</th>
            <th className="px-4 py-2 font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} className="border-t border-zinc-800/70 align-top">
              <td className="px-4 py-2 text-zinc-400">{k}</td>
              <td className="px-4 py-2 break-all text-zinc-100">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const lineWrap = EditorView.lineWrapping;

export function CodeView({
  value,
  language,
  onChange,
  minHeight,
}: {
  value: string;
  language?: "json" | "text";
  onChange?: (value: string) => void;
  minHeight?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800">
      <CodeMirror
        value={value}
        theme={githubDark}
        editable={!!onChange}
        readOnly={!onChange}
        onChange={onChange}
        minHeight={minHeight}
        extensions={language === "json" ? [json(), lineWrap] : [lineWrap]}
        basicSetup={{ foldGutter: true, highlightActiveLine: !!onChange }}
      />
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-xl border border-zinc-800 bg-zinc-900/40", className)}>{children}</section>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-zinc-400 uppercase">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "rounded-md border border-zinc-700 bg-zinc-950 px-3 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none";

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Re-renders the caller every `ms` so relative times stay fresh. */
export function useNow(ms = 10_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}
