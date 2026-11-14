import { Download, Plus, Radio, RefreshCw, Send, Settings, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, exportUrl, hookUrl, streamUrl, type CapturedRequestSummary, type Endpoint } from "./api";
import { RequestDetail } from "./RequestDetail";
import { Button, CopyButton, cx, Field, formatBytes, inputClass, MethodBadge, Panel, timeAgo, useNow } from "./ui";

const goTo = (id: string) => (window.location.hash = `#/receiver/${id}`);

export function Receiver({ endpointId }: { endpointId: string | null }) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadEndpoints = useCallback(async () => {
    let list = await api.listEndpoints();
    if (list.length === 0) list = [await api.createEndpoint({ name: "Default" })];
    setEndpoints(list);
    return list;
  }, []);

  useEffect(() => {
    reloadEndpoints().catch((e) => setError(String(e)));
  }, [reloadEndpoints]);

  // Fall back to the first endpoint when the hash has none or an unknown one.
  const endpoint = endpoints?.find((e) => e.id === endpointId) ?? null;
  useEffect(() => {
    if (endpoints && !endpoint && endpoints[0]) goTo(endpoints[0].id);
  }, [endpoints, endpoint]);

  if (error) return <p className="text-rose-400">{error}</p>;
  if (!endpoint || !endpoints) return null;

  return <EndpointView key={endpoint.id} endpoint={endpoint} endpoints={endpoints} onEndpointsChanged={reloadEndpoints} />;
}

function EndpointView({
  endpoint,
  endpoints,
  onEndpointsChanged,
}: {
  endpoint: Endpoint;
  endpoints: Endpoint[];
  onEndpointsChanged: () => Promise<Endpoint[]>;
}) {
  const [requests, setRequests] = useState<CapturedRequestSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const now = useNow();
  const url = hookUrl(endpoint.id);

  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShowSettings(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

  const reload = useCallback(async () => {
    const list = await api.listRequests(endpoint.id);
    setRequests(list);
    setSelectedId((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)));
  }, [endpoint.id]);

  useEffect(() => {
    void reload();
    const es = new EventSource(streamUrl(endpoint.id));
    es.addEventListener("ready", () => setLive(true));
    es.addEventListener("request", (e) => {
      const req = JSON.parse((e as MessageEvent).data) as CapturedRequestSummary;
      setRequests((cur) => [req, ...cur.filter((r) => r.id !== req.id)]);
      setSelectedId((cur) => cur ?? req.id);
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [endpoint.id, reload]);

  const sendTest = () =>
    fetch(`${url}/test?source=localhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-localhook-test": "1" },
      body: JSON.stringify({ event: "test.ping", sentAt: new Date().toISOString(), data: { hello: "world" } }),
    });

  const createEndpoint = async () => {
    const id = prompt("Endpoint id (letters, digits, - and _). Leave empty for a random id.");
    if (id === null) return;
    try {
      const ep = await api.createEndpoint({ id: id.trim() || undefined });
      await onEndpointsChanged();
      goTo(ep.id);
    } catch (e) {
      alert(String(e));
    }
  };

  const deleteEndpoint = async () => {
    if (!confirm(`Delete endpoint "${endpoint.name}" and all its requests?`)) return;
    await api.deleteEndpoint(endpoint.id);
    const list = await onEndpointsChanged();
    if (list[0]) goTo(list[0].id);
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <Panel className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={endpoint.id}
            onChange={(e) => goTo(e.target.value)}
            className={cx(inputClass, "h-9 font-sans font-semibold")}
            aria-label="Endpoint"
          >
            {endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <span
            className={cx(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
              live ? "border-emerald-500/40 text-emerald-400" : "border-zinc-700 text-zinc-500",
            )}
          >
            <Radio className="size-3.5" />
            {live ? "Listening" : "Reconnecting…"}
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={createEndpoint}>
              <Plus className="size-4" /> New endpoint
            </Button>
            <Button size="sm" variant={showSettings ? "primary" : "secondary"} onClick={() => setShowSettings((s) => !s)}>
              <Settings className="size-4" /> Response
            </Button>
            <Button size="icon" variant="danger" title="Delete endpoint" onClick={deleteEndpoint}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex gap-2">
          <div className={cx(inputClass, "flex h-10 flex-1 items-center justify-between gap-2 pr-1")}>
            <span className="truncate">{url}</span>
            <CopyButton text={url} />
          </div>
          <Button onClick={sendTest}>
            <Send className="size-4" /> Send test request
          </Button>
        </div>
        <p className="-mt-2 text-xs text-zinc-500">
          Send any HTTP method to this URL or any subpath of it. From other containers, use the container name instead
          of <code>localhost</code>.
        </p>

        {showSettings && (
          <ResponseSettings
            endpoint={endpoint}
            onSaved={async () => {
              await onEndpointsChanged();
              setShowSettings(false);
            }}
          />
        )}
      </Panel>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(300px,380px)_1fr]">
        <Panel className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
            <h2 className="font-semibold">Requests</h2>
            <span className="rounded-full bg-zinc-800 px-2 text-xs">{requests.length}</span>
            <div className="ml-auto flex">
              <a href={exportUrl(endpoint.id)} title="Export as JSON">
                <Button variant="ghost" size="icon" tabIndex={-1}>
                  <Download className="size-4" />
                </Button>
              </a>
              <Button variant="ghost" size="icon" title="Refresh" onClick={reload}>
                <RefreshCw className="size-4" />
              </Button>
              <Button
                variant="danger"
                size="icon"
                title="Clear all requests"
                onClick={async () => {
                  await api.clearRequests(endpoint.id);
                  await reload();
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {requests.length === 0 && (
              <li className="p-6 text-center text-sm text-zinc-500">Waiting for the first request…</li>
            )}
            {requests.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  className={cx(
                    "flex w-full flex-col gap-1.5 border-b border-l-2 border-b-zinc-800/60 px-4 py-3 text-left transition-colors",
                    r.id === selectedId ? "border-l-sky-500 bg-zinc-800/50" : "border-l-transparent hover:bg-zinc-800/30",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <MethodBadge method={r.method} />
                    <span className="text-xs text-zinc-500">{timeAgo(r.createdAt, now)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 font-mono text-xs">
                    <span className="truncate text-zinc-200">{r.path}</span>
                    <span className="shrink-0 text-zinc-500">{formatBytes(r.size)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="min-h-0 overflow-y-auto">
          {selectedId ? (
            <RequestDetail key={selectedId} id={selectedId} endpointId={endpoint.id} onDeleted={reload} />
          ) : (
            <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-8 text-center text-zinc-500">
              <p>No request selected.</p>
              <p className="font-mono text-xs">curl -X POST {url} -d '{`{"hello":"world"}`}'</p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function ResponseSettings({ endpoint, onSaved }: { endpoint: Endpoint; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: endpoint.name,
    responseStatus: String(endpoint.responseStatus),
    responseContentType: endpoint.responseContentType,
    responseBody: endpoint.responseBody,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <form
      className="grid gap-4 border-t border-zinc-800 pt-4 md:grid-cols-[1fr_120px_1fr]"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.updateEndpoint(endpoint.id, { ...form, responseStatus: Number(form.responseStatus) });
          onSaved();
        } catch (err) {
          setError(String(err));
        }
      }}
    >
      <Field label="Name">
        <input className={cx(inputClass, "h-10")} value={form.name} onChange={set("name")} />
      </Field>
      <Field label="Status">
        <input className={cx(inputClass, "h-10")} value={form.responseStatus} onChange={set("responseStatus")} inputMode="numeric" />
      </Field>
      <Field label="Content type">
        <input className={cx(inputClass, "h-10")} value={form.responseContentType} onChange={set("responseContentType")} />
      </Field>
      <div className="md:col-span-3">
        <Field label="Response body">
          <textarea className={cx(inputClass, "h-24 py-2")} value={form.responseBody} onChange={set("responseBody")} />
        </Field>
      </div>
      <div className="flex items-center gap-3 md:col-span-3">
        <Button variant="primary" size="sm" type="submit">
          Save
        </Button>
        {error && <span className="text-sm text-rose-400">{error}</span>}
      </div>
    </form>
  );
}
