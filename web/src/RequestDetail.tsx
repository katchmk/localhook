import {
  Clock,
  Download,
  FileType,
  Forward,
  Globe,
  HardDrive,
  Network,
  Repeat,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { multipartBoundary, parseMultipart, type MultipartPart } from "./multipart";
import {
  api,
  bodyUrl,
  hookUrl,
  type CapturedRequest,
  type ForwardResult,
  type HeaderPair,
  type SentRequest,
} from "./api";
import {
  Button,
  CodeView,
  CopyButton,
  cx,
  formatBytes,
  inputClass,
  KeyValueTable,
  MethodBadge,
  parseCookies,
  prettyJson,
  SCHEME_NAMES,
  StatusBadge,
  Tabs,
  toCurl,
} from "./ui";

type Tab = "headers" | "query" | "cookies" | "body" | "raw";


export function RequestDetail({
  id,
  endpointId,
  forward,
  onDeleted,
}: {
  id: string;
  endpointId: string;
  /** From the live summary, because the forward result can arrive after the detail loads. */
  forward: ForwardResult | null;
  onDeleted: () => void;
}) {
  const [req, setReq] = useState<CapturedRequest | null>(null);
  const [tab, setTab] = useState<Tab>("body");

  useEffect(() => {
    api.getRequest(id).then((r) => {
      setReq(r);
      if (r.size === 0) setTab("headers");
    });
  }, [id]);

  if (!req) return null;

  const fullUrl = `${hookUrl(endpointId)}${req.path === "/" ? "" : req.path}${req.query}`;
  const query: HeaderPair[] = [...new URLSearchParams(req.query).entries()];
  const cookies = parseCookies(req.headers);
  const raw = JSON.stringify(req, null, 2);
  const created = new Date(req.createdAt);

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <MethodBadge method={req.method} large />
        <h2 className="text-lg font-semibold">Request details</h2>
        <div className="ml-auto flex gap-2">
          <a
            href={`#/sender/${req.id}`}
            title="Open in Sender to change and send it"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm font-medium text-zinc-100 hover:bg-zinc-800"
          >
            <Send className="size-4" /> Sender
          </a>
          <CopyButton text={toCurl({ ...req, url: fullUrl })} label="cURL" />
          <CopyButton text={raw} label="JSON" />
          <Button
            variant="danger"
            size="icon"
            title="Delete request"
            onClick={async () => {
              await api.deleteRequest(req.id);
              onDeleted();
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-5 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
        <Meta icon={<Globe />} label="Request URL">
          <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm break-all">{fullUrl}</div>
        </Meta>
        <div className="grid grid-cols-2 gap-4 border-t border-zinc-800 pt-4 md:grid-cols-4">
          <Meta icon={<Clock />} label="Time">
            <div className="font-semibold">{created.toLocaleTimeString()}</div>
            <div className="text-xs text-zinc-500">{created.toLocaleDateString()}</div>
          </Meta>
          <Meta icon={<Network />} label="IP address">
            <span className="font-mono">{req.ip ?? "—"}</span>
          </Meta>
          <Meta icon={<HardDrive />} label="Size">
            <span className="font-mono">{formatBytes(req.size)}</span>
          </Meta>
          <Meta icon={<FileType />} label="Content type">
            {req.contentType ? (
              <span className="font-mono text-sm break-all">{req.contentType}</span>
            ) : (
              <span className="text-zinc-500 italic">None</span>
            )}
          </Meta>
        </div>
        {(req.signature || forward) && (
          <div className="grid gap-4 border-t border-zinc-800 pt-4 md:grid-cols-2">
            {req.signature && (
              <Meta icon={req.signature.valid ? <ShieldCheck /> : <ShieldAlert />} label="Signature">
                <span className={cx("text-sm", req.signature.valid ? "text-emerald-400" : "text-rose-400")}>
                  {SCHEME_NAMES[req.signature.scheme]}: {req.signature.message}
                </span>
              </Meta>
            )}
            {forward && (
              <Meta icon={<Forward />} label="Forwarded">
                <span className="flex items-center gap-2 text-sm">
                  <StatusBadge status={forward.status} error={forward.error} />
                  <span className="truncate font-mono text-zinc-300" title={forward.url}>
                    {forward.url}
                  </span>
                  <span className="shrink-0 text-zinc-500">{forward.durationMs} ms</span>
                </span>
                {forward.error && <span className="font-mono text-xs text-rose-400">{forward.error}</span>}
              </Meta>
            )}
          </div>
        )}
      </div>

      <Replay requestId={req.id} />

      <div className="flex flex-col gap-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "body", label: "Body" },
            { id: "headers", label: "Headers", count: req.headers.length },
            { id: "query", label: "Query params", count: query.length },
            { id: "cookies", label: "Cookies", count: cookies.length },
            { id: "raw", label: "Raw" },
          ]}
        />
        {tab === "headers" && <KeyValueTable rows={req.headers} empty="No headers." />}
        {tab === "query" && <KeyValueTable rows={query} empty="No query parameters." />}
        {tab === "cookies" && <KeyValueTable rows={cookies} empty="No cookies." />}
        {tab === "body" && <Body req={req} />}
        {tab === "raw" && <CodeView value={raw} language="json" />}
      </div>
    </div>
  );
}

function Meta({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-zinc-400 uppercase [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function Body({ req }: { req: CapturedRequest }) {
  if (req.size === 0) return <p className="p-4 text-sm text-zinc-500 italic">Empty body.</p>;
  const boundary = multipartBoundary(req.contentType);
  if (boundary) return <MultipartBody req={req} boundary={boundary} />;
  if (req.bodyEncoding === "base64") return <BinaryBody req={req} />;
  if (req.contentType?.includes("application/x-www-form-urlencoded")) {
    return <KeyValueTable rows={[...new URLSearchParams(req.body).entries()]} empty="No form fields." />;
  }
  const pretty = prettyJson(req.body);
  return <CodeView value={pretty ?? req.body} language={pretty ? "json" : "text"} />;
}

const bodyBytes = (req: CapturedRequest) =>
  req.bodyEncoding === "base64"
    ? Uint8Array.from(atob(req.body), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(req.body);

/** The part's text, or null when it is a file or not valid UTF-8. */
function partText(part: MultipartPart): string | null {
  if (part.filename !== null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(part.data);
  } catch {
    return null;
  }
}

function downloadPart(part: MultipartPart, index: number) {
  const url = URL.createObjectURL(new Blob([part.data as Uint8Array<ArrayBuffer>], { type: part.contentType ?? "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = part.filename || part.name || `part-${index + 1}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function MultipartBody({ req, boundary }: { req: CapturedRequest; boundary: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const parsed = useMemo(() => {
    try {
      return parseMultipart(bodyBytes(req), boundary);
    } catch (e) {
      return String(e);
    }
  }, [req, boundary]);

  const raw =
    req.bodyEncoding === "base64" ? <BinaryBody req={req} /> : <CodeView value={req.body} language="text" />;
  if (typeof parsed === "string") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-amber-400">Cannot read the multipart body: {parsed}</p>
        {raw}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-400">
          {parsed.length} part{parsed.length === 1 ? "" : "s"}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? "Show parts" : "Show raw"}
        </Button>
      </div>
      {showRaw ? (
        raw
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-left font-mono text-[13px]">
            <thead className="bg-zinc-900 text-xs text-zinc-400">
              <tr>
                <th className="w-1/4 px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {parsed.map((part, i) => {
                const text = partText(part);
                return (
                  <tr key={i} className="border-t border-zinc-800/70 align-top">
                    <td className="px-4 py-2 text-zinc-400">{part.name ?? <span className="italic">none</span>}</td>
                    <td className="px-4 py-2 text-zinc-100">
                      {text !== null ? (
                        <span className="break-all whitespace-pre-wrap">{text}</span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-3">
                          <span className="break-all">{part.filename || "Binary value"}</span>
                          <span className="text-zinc-500">
                            {formatBytes(part.data.length)}
                            {part.contentType && `, ${part.contentType}`}
                          </span>
                          <Button size="sm" variant="ghost" onClick={() => downloadPart(part, i)}>
                            <Download className="size-4" /> Download
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BinaryBody({ req }: { req: CapturedRequest }) {
  const [showBase64, setShowBase64] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
        <span className="text-sm text-zinc-300">
          Binary body, {formatBytes(req.size)}
          {req.contentType && <span className="text-zinc-500"> ({req.contentType})</span>}
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowBase64((v) => !v)}>
            {showBase64 ? "Hide base64" : "Show base64"}
          </Button>
          <a
            href={bodyUrl(req.id)}
            download
            className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm font-medium text-zinc-100 hover:bg-zinc-800"
          >
            <Download className="size-4" /> Download
          </a>
        </div>
      </div>
      {showBase64 && <CodeView value={req.body} />}
    </div>
  );
}

function Replay({ requestId }: { requestId: string }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SentRequest | string | null>(null);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          setResult(await api.replay(requestId, url));
        } catch (err) {
          setResult(String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex gap-2">
        <input
          className={cx(inputClass, "h-9 flex-1")}
          placeholder="Replay to URL, e.g. http://host.docker.internal:3000/webhooks"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <Button size="sm" className="h-9" type="submit" disabled={busy}>
          <Repeat className="size-4" /> {busy ? "Sending…" : "Replay"}
        </Button>
      </div>
      {typeof result === "string" && <p className="text-sm text-rose-400">{result}</p>}
      {result && typeof result === "object" && (
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <StatusBadge status={result.status} error={result.error} />
          {result.error ?? `${result.durationMs} ms`}
          <a href="#/sender" className="ml-auto text-sky-400 hover:underline">
            See in Sender history
          </a>
        </p>
      )}
    </form>
  );
}
