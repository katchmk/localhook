import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { githubDark } from "@uiw/codemirror-theme-github";
import CodeMirror from "@uiw/react-codemirror";
import { Check, Copy, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { SIGNATURE_ALGORITHMS, type CustomSignature, type HeaderPair, type SignatureScheme } from "./api";

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

/** Shows `label` below the child on hover or keyboard focus. Faster and styled, unlike `title`. */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cx(
          "pointer-events-none absolute top-full left-1/2 z-20 mt-1.5 -translate-x-1/2 whitespace-nowrap",
          "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 shadow-lg",
          "opacity-0 transition-opacity delay-0 group-focus-within/tip:opacity-100 group-hover/tip:opacity-100 group-hover/tip:delay-300",
        )}
      >
        {label}
      </span>
    </span>
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
      type="button"
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
          type="button"
          onClick={() => onChange(t.id)}
          className={cx(
            "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
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

/**
 * A labeled form field. Use `group` for controls made of several buttons: a <label> would
 * send clicks on its text to the first button.
 */
export function Field({
  label,
  group,
  className,
  children,
}: {
  label: string;
  group?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const title = <span className="text-xs font-medium tracking-wide text-zinc-400 uppercase">{label}</span>;
  return group ? (
    <div role="group" aria-label={label} className={cx("flex flex-col gap-1.5", className)}>
      {title}
      {children}
    </div>
  ) : (
    <label className={cx("flex flex-col gap-1.5", className)}>
      {title}
      {children}
    </label>
  );
}

/** A row of buttons where one is selected, e.g. Text / Binary file. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 self-start rounded-md border border-zinc-800 p-0.5 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded px-3 py-1 whitespace-nowrap transition-colors",
            value === o.value ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
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

// curl sets these itself, or they describe the original connection.
const CURL_SKIP = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]);

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A curl command that sends the same request. Binary bodies are piped in from base64. */
export function toCurl(r: { method: string; url: string; headers: HeaderPair[]; body: string; bodyEncoding?: string }) {
  const parts = [r.method === "HEAD" ? "curl --head" : `curl -X ${r.method}`, shellQuote(r.url)];
  for (const [k, v] of r.headers) {
    if (k.trim() && !CURL_SKIP.has(k.trim().toLowerCase())) parts.push(`-H ${shellQuote(`${k.trim()}: ${v}`)}`);
  }
  if (!r.body) return parts.join(" \\\n  ");
  if (r.bodyEncoding === "base64") {
    return `printf %s ${shellQuote(r.body)} | base64 -d | ${[...parts, "--data-binary @-"].join(" \\\n  ")}`;
  }
  return [...parts, `--data-binary ${shellQuote(r.body)}`].join(" \\\n  ");
}

export const SCHEME_LABELS: Record<SignatureScheme, string> = {
  github: "GitHub (X-Hub-Signature-256)",
  stripe: "Stripe (Stripe-Signature)",
  shopify: "Shopify (X-Shopify-Hmac-Sha256)",
  slack: "Slack (X-Slack-Signature)",
  standard: "Standard Webhooks / Svix (webhook-signature)",
  custom: "Custom HMAC header",
};

/** Short names, for buttons and badges. */
export const SCHEME_NAMES: Record<SignatureScheme, string> = {
  github: "GitHub",
  stripe: "Stripe",
  shopify: "Shopify",
  slack: "Slack",
  standard: "Standard Webhooks",
  custom: "Custom",
};

const ALGORITHM_NAMES: Record<CustomSignature["algorithm"], string> = {
  sha256: "SHA-256",
  sha1: "SHA-1",
  sha512: "SHA-512",
};

/** The payload template with its {body} and {header:Name} tokens colored. */
function PayloadTokens({ payload }: { payload: string }) {
  return (
    <>
      {payload.split(/(\{body\}|\{header:[^}]+\})/g).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="text-sky-300">
            {part}
          </span>
        ) : (
          <span key={i} className="text-zinc-300">
            {part}
          </span>
        ),
      )}
    </>
  );
}

/**
 * Header, algorithm, encoding and payload template of a custom HMAC signature.
 * `mode` changes the help text: "verify" for received requests, "sign" for sent ones.
 */
export function CustomSignatureFields({
  value,
  onChange,
  mode,
}: {
  value: CustomSignature;
  onChange: (value: CustomSignature) => void;
  mode: "verify" | "sign";
}) {
  const payloadInput = useRef<HTMLInputElement>(null);
  // Inserts at the cursor, or at the end when the field has no focus yet.
  const insert = (token: string) => {
    const el = payloadInput.current;
    const start = el?.selectionStart ?? value.payload.length;
    const end = el?.selectionEnd ?? start;
    onChange({ ...value, payload: value.payload.slice(0, start) + token + value.payload.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="flex max-w-3xl flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Header" className="min-w-40 flex-1">
          <input
            className={cx(inputClass, "h-9")}
            placeholder="X-Signature"
            value={value.header}
            onChange={(e) => onChange({ ...value, header: e.target.value })}
            spellCheck={false}
          />
        </Field>
        <Field label="Algorithm" group>
          <Segmented
            value={value.algorithm}
            options={SIGNATURE_ALGORITHMS.map((a) => ({ value: a, label: ALGORITHM_NAMES[a] }))}
            onChange={(algorithm) => onChange({ ...value, algorithm })}
          />
        </Field>
        <Field label="Encoding" group>
          <Segmented
            value={value.encoding}
            options={[
              { value: "hex", label: "Hex" },
              { value: "base64", label: "Base64" },
            ]}
            onChange={(encoding) => onChange({ ...value, encoding })}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <Field label="Signed payload">
          <input
            ref={payloadInput}
            className={cx(inputClass, "h-9")}
            placeholder="{body}"
            value={value.payload}
            onChange={(e) => onChange({ ...value, payload: e.target.value })}
            spellCheck={false}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          Insert
          <button
            type="button"
            className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-sky-300 hover:bg-zinc-800"
            title="The raw request body"
            onClick={() => insert("{body}")}
          >
            {"{body}"}
          </button>
          <button
            type="button"
            className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-sky-300 hover:bg-zinc-800"
            title="The value of a request header. Change Name to the header name."
            onClick={() => insert("{header:Name}")}
          >
            {"{header:Name}"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs whitespace-nowrap text-zinc-500">
        <span className="text-zinc-300">{value.header || "X-Signature"}</span>: {value.encoding}(HMAC-
        {ALGORITHM_NAMES[value.algorithm]}(secret, "<PayloadTokens payload={value.payload} />"))
      </div>
      {mode === "verify" && (
        <p className="-mt-2 text-xs text-zinc-500">
          A <code>{value.algorithm}=</code> prefix on the received signature is allowed.
        </p>
      )}
    </div>
  );
}

/** Editable [name, value] rows, e.g. headers, cookies or variables. */
export function PairEditor({
  pairs,
  noun,
  onChange,
}: {
  pairs: HeaderPair[];
  noun: "header" | "cookie" | "variable";
  onChange: (p: HeaderPair[]) => void;
}) {
  const update = (i: number, pos: 0 | 1, value: string) =>
    onChange(pairs.map((h, j) => (j === i ? (pos === 0 ? [value, h[1]] : [h[0], value]) : h)));
  return (
    <div className="flex flex-col gap-2">
      {pairs.map(([k, v], i) => (
        <div key={i} className="flex gap-2">
          <input
            className={cx(inputClass, "h-9 w-1/3 min-w-0")}
            placeholder={noun === "header" ? "Header" : "Name"}
            value={k}
            onChange={(e) => update(i, 0, e.target.value)}
          />
          <input
            className={cx(inputClass, "h-9 min-w-0 flex-1")}
            placeholder="Value"
            value={v}
            onChange={(e) => update(i, 1, e.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="size-9"
            title={`Remove ${noun}`}
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button size="sm" type="button" className="self-start" onClick={() => onChange([...pairs, ["", ""]])}>
        <Plus className="size-4" /> Add {noun}
      </Button>
    </div>
  );
}
