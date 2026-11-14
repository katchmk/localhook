import { FileUp, Plus, Send, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type HeaderPair, type SentRequest } from "./api";
import {
  Button,
  CodeView,
  cx,
  formatBytes,
  inputClass,
  joinCookies,
  KeyValueTable,
  MethodBadge,
  Panel,
  parseSetCookies,
  prettyJson,
  splitCookies,
 
  StatusBadge,
  Tabs,
  timeAgo,
  useNow,
} from "./ui";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

interface Draft {
  method: string;
  url: string;
  headers: HeaderPair[];
  cookies: HeaderPair[];
  body: string;
  bodyMode: "text" | "file";
  /** Binary body for "file" mode; `data` is base64. */
  file: { name: string; size: number; data: string } | null;
}

const initialDraft = (): Draft => ({
  method: "POST",
  url: "",
  headers: [["Content-Type", "application/json"]],
  cookies: [],
  body: JSON.stringify({ event: "order.created", data: { id: 123 } }, null, 2),
  bodyMode: "text",
  file: null,
});

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // The result is a data URL: "data:<type>;base64,<data>".
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Sets the Content-Type header, replacing any existing one. */
function withContentType(headers: HeaderPair[], type: string): HeaderPair[] {
  const rest = headers.filter(([k]) => k.trim().toLowerCase() !== "content-type");
  return [["Content-Type", type], ...rest];
}

export function Sender() {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [history, setHistory] = useState<SentRequest[]>([]);
  const [response, setResponse] = useState<SentRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"body" | "headers" | "cookies">("body");
  const now = useNow();

  const reloadHistory = () => api.listSent().then(setHistory);
  useEffect(() => {
    void reloadHistory();
    // Default the target to the first local endpoint, so a first send shows up in the Receiver.
    api.listEndpoints().then((eps) => {
      if (eps[0]) setDraft((d) => (d.url ? d : { ...d, url: `http://localhost:8080/hook/${eps[0]!.id}` }));
    });
  }, []);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.send({
        method: draft.method,
        url: draft.url,
        headers: joinCookies(draft.headers.filter(([k]) => k.trim()), draft.cookies),
        ...(draft.bodyMode === "file"
          ? { body: draft.file?.data ?? "", bodyEncoding: "base64" }
          : { body: draft.body, bodyEncoding: "utf8" }),
      });
      setResponse(res);
      await reloadHistory();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const load = (s: SentRequest) => {
    const { headers, cookies } = splitCookies(s.headers);
    const binary = s.bodyEncoding === "base64";
    setDraft({
      method: s.method,
      url: s.url,
      headers: headers.length ? headers : [["", ""]],
      cookies,
      body: binary ? "" : s.body,
      bodyMode: binary ? "file" : "text",
      file: binary ? { name: "Binary body from history", size: atob(s.body).length, data: s.body } : null,
    });
    setResponse(s);
  };

  return (
    <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
      <Panel className="flex min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <h2 className="font-semibold">History</h2>
          <span className="rounded-full bg-zinc-800 px-2 text-xs">{history.length}</span>
          <Button
            variant="danger"
            size="icon"
            className="ml-auto"
            title="Clear history"
            onClick={async () => {
              await api.clearSent();
              await reloadHistory();
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {history.length === 0 && <li className="p-6 text-center text-sm text-zinc-500">No requests sent yet.</li>}
          {history.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => load(s)}
                className={cx(
                  "flex w-full flex-col gap-1.5 border-b border-l-2 border-b-zinc-800/60 px-4 py-3 text-left hover:bg-zinc-800/30",
                  response?.id === s.id ? "border-l-sky-500 bg-zinc-800/50" : "border-l-transparent",
                )}
              >
                <div className="flex items-center gap-2">
                  <MethodBadge method={s.method} />
                  <StatusBadge status={s.status} error={s.error} />
                  <span className="ml-auto text-xs text-zinc-500">{timeAgo(s.createdAt, now)}</span>
                </div>
                <span className="truncate font-mono text-xs text-zinc-300">{s.url}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <Panel className="flex flex-col gap-4 p-5">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <select
              className={cx(inputClass, "h-10 font-semibold")}
              value={draft.method}
              onChange={(e) => setDraft({ ...draft, method: e.target.value })}
              aria-label="Method"
            >
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <input
              className={cx(inputClass, "h-10 flex-1")}
              placeholder="https://example.com/webhook"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              required
            />
            <Button variant="primary" type="submit" disabled={busy}>
              <Send className="size-4" /> {busy ? "Sending…" : "Send"}
            </Button>
          </form>
          <p className="-mt-2 text-xs text-zinc-500">
            The server sends the request, so CORS does not apply. Inside Docker, <code>localhost</code> is the
            container itself; use <code>host.docker.internal</code> to reach services on your computer.
          </p>
          {error && <p className="text-sm text-rose-400">{error}</p>}

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "body", label: "Body" },
              { id: "headers", label: "Headers", count: draft.headers.filter(([k]) => k.trim()).length },
              { id: "cookies", label: "Cookies", count: draft.cookies.filter(([k]) => k.trim()).length },
            ]}
          />
          {tab === "body" ? (
            <BodyEditor draft={draft} setDraft={setDraft} />
          ) : tab === "headers" ? (
            <PairEditor pairs={draft.headers} noun="header" onChange={(headers) => setDraft({ ...draft, headers })} />
          ) : (
            <PairEditor pairs={draft.cookies} noun="cookie" onChange={(cookies) => setDraft({ ...draft, cookies })} />
          )}
        </Panel>

        {response ? (
          <ResponseView res={response} />
        ) : (
          <Panel className="p-5 text-sm text-zinc-500">No response yet. Send a request or select one from the history.</Panel>
        )}
      </div>
    </div>
  );
}

function BodyEditor({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: (update: (d: Draft) => Draft) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const data = await readBase64(file);
      setDraft((d) => ({
        ...d,
        file: { name: file.name, size: file.size, data },
        headers: withContentType(d.headers, file.type || "application/octet-stream"),
      }));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 self-start rounded-md border border-zinc-800 p-0.5 text-sm">
        {(["text", "file"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setDraft((d) => ({ ...d, bodyMode: mode }))}
            className={cx(
              "rounded px-3 py-1 transition-colors",
              draft.bodyMode === mode ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            {mode === "text" ? "Text" : "Binary file"}
          </button>
        ))}
      </div>
      {draft.bodyMode === "text" ? (
        <CodeView
          value={draft.body}
          language="json"
          minHeight="160px"
          onChange={(body) => setDraft((d) => ({ ...d, body }))}
        />
      ) : (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-zinc-700 p-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void pick(e.dataTransfer.files[0]);
          }}
        >
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = ""; // Allow picking the same file again.
            }}
          />
          <Button size="sm" type="button" onClick={() => fileInput.current?.click()}>
            <FileUp className="size-4" /> Choose file
          </Button>
          {draft.file ? (
            <>
              <span className="truncate font-mono text-sm text-zinc-200">{draft.file.name}</span>
              <span className="text-sm text-zinc-400">{formatBytes(draft.file.size)}</span>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                title="Remove file"
                onClick={() => setDraft((d) => ({ ...d, file: null }))}
              >
                <X className="size-4" />
              </Button>
            </>
          ) : (
            <span className="text-sm text-zinc-500">or drop a file here. The raw bytes are sent as the body.</span>
          )}
          {error && <p className="w-full text-sm text-rose-400">{error}</p>}
        </div>
      )}
    </div>
  );
}

function PairEditor({
  pairs,
  noun,
  onChange,
}: {
  pairs: HeaderPair[];
  noun: "header" | "cookie";
  onChange: (p: HeaderPair[]) => void;
}) {
  const update = (i: number, pos: 0 | 1, value: string) =>
    onChange(pairs.map((h, j) => (j === i ? (pos === 0 ? [value, h[1]] : [h[0], value]) : h)));
  return (
    <div className="flex flex-col gap-2">
      {pairs.map(([k, v], i) => (
        <div key={i} className="flex gap-2">
          <input
            className={cx(inputClass, "h-9 w-1/3")}
            placeholder={noun === "header" ? "Header" : "Name"}
            value={k}
            onChange={(e) => update(i, 0, e.target.value)}
          />
          <input
            className={cx(inputClass, "h-9 flex-1")}
            placeholder="Value"
            value={v}
            onChange={(e) => update(i, 1, e.target.value)}
          />
          <Button variant="ghost" size="icon" className="size-9" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button size="sm" className="self-start" onClick={() => onChange([...pairs, ["", ""]])}>
        <Plus className="size-4" /> Add {noun}
      </Button>
    </div>
  );
}

function ResponseView({ res }: { res: SentRequest }) {
  const [tab, setTab] = useState<"body" | "headers" | "cookies">("body");
  const pretty = prettyJson(res.responseBody);
  const cookies = parseSetCookies(res.responseHeaders);
  return (
    <Panel className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Response</h2>
        <StatusBadge status={res.status} error={res.error} />
        <span className="text-sm text-zinc-400">{res.durationMs} ms</span>
        <span className="text-sm text-zinc-400">{formatBytes(new TextEncoder().encode(res.responseBody).length)}</span>
      </div>
      {res.error && (
        <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 font-mono text-sm text-rose-300">
          {res.error}
        </p>
      )}
      {res.status !== null && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "body", label: "Body" },
              { id: "headers", label: "Headers", count: res.responseHeaders.length },
              { id: "cookies", label: "Cookies", count: cookies.length },
            ]}
          />
          {tab === "body" ? (
            res.responseBody ? (
              <CodeView value={pretty ?? res.responseBody} language={pretty ? "json" : "text"} />
            ) : (
              <p className="p-4 text-sm text-zinc-500 italic">Empty body.</p>
            )
          ) : tab === "headers" ? (
            <KeyValueTable rows={res.responseHeaders} empty="No headers." />
          ) : (
            <KeyValueTable rows={cookies} empty="No cookies." />
          )}
        </>
      )}
    </Panel>
  );
}
