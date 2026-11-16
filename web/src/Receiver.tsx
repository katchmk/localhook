import {
  Download,
  FileDown,
  Forward,
  GitCompare,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  exportUrl,
  FORWARD_MODES,
  hookUrl,
  SIGNATURE_SCHEMES,
  streamUrl,
  type CapturedRequestSummary,
  type Endpoint,
  type ResponseRule,
} from "./api";
import { RequestDetail } from "./RequestDetail";
import { RequestDiff } from "./RequestDiff";
import {
  Button,
  CopyButton,
  CustomSignatureFields,
  cx,
  Field,
  formatBytes,
  inputClass,
  MethodBadge,
  Panel,
  SCHEME_LABELS,
  StatusBadge,
  timeAgo,
  Tooltip,
  useNow,
} from "./ui";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

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
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState(""); // `search`, applied after a short pause in typing
  const [method, setMethod] = useState("");
  /** Ids picked for compare; null when compare mode is off. */
  const [compare, setCompare] = useState<string[] | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const now = useNow();
  const url = hookUrl(endpoint.id);
  const filtered = !!(query || method);
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShowSettings(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

  const reload = useCallback(async () => {
    const list = await api.listRequests(endpoint.id, { q: query, method });
    setRequests(list);
    setSelectedId((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)));
  }, [endpoint.id, query, method]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const es = new EventSource(streamUrl(endpoint.id));
    es.addEventListener("ready", () => setLive(true));
    es.addEventListener("request", (e) => {
      // The summary has no headers or body, so only the server can tell if it matches a search.
      if (filteredRef.current) return void reloadRef.current();
      const req = JSON.parse((e as MessageEvent).data) as CapturedRequestSummary;
      // A known id is an update, e.g. a forward result; keep its place in the list.
      setRequests((cur) =>
        cur.some((r) => r.id === req.id) ? cur.map((r) => (r.id === req.id ? req : r)) : [req, ...cur],
      );
      setSelectedId((cur) => cur ?? req.id);
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [endpoint.id]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const { imported } = await api.importRequests(endpoint.id, await file.text());
      await reload();
      await onEndpointsChanged();
      alert(`Imported ${imported} request${imported === 1 ? "" : "s"}.`);
    } catch (e) {
      alert(String(e));
    }
  };

  const toggleCompare = (id: string) =>
    setCompare((cur) => {
      if (!cur) return cur;
      if (cur.includes(id)) return cur.filter((c) => c !== id);
      return [...cur, id].slice(-2); // A third pick replaces the oldest pick.
    });

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
              <Settings className="size-4" /> Settings
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

        {(endpoint.forwardUrl || endpoint.signatureScheme || endpoint.responseRules.length > 0) && !showSettings && (
          <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
            {endpoint.forwardUrl && (
              <span className="flex items-center gap-1">
                <Forward className="size-3.5" /> {endpoint.forwardMode === "proxy" ? "Proxies" : "Forwards"} to{" "}
                <code className="text-zinc-200">{endpoint.forwardUrl}</code>
              </span>
            )}
            {endpoint.signatureScheme && <span>Checks {endpoint.signatureScheme} signatures</span>}
            {endpoint.responseRules.length > 0 && (
              <span>
                {endpoint.responseRules.length} response rule{endpoint.responseRules.length === 1 ? "" : "s"}
              </span>
            )}
          </p>
        )}

        {showSettings && (
          <EndpointSettings
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
              <Tooltip label={compare ? "Stop comparing" : "Compare two requests"}>
                <Button
                  variant={compare ? "primary" : "ghost"}
                  size="icon"
                  aria-label={compare ? "Stop comparing" : "Compare two requests"}
                  onClick={() => setCompare((cur) => (cur ? null : []))}
                >
                  <GitCompare className="size-4" />
                </Button>
              </Tooltip>
              <input
                ref={importInput}
                type="file"
                accept=".json,.har,application/json"
                className="hidden"
                onChange={(e) => {
                  void importFile(e.target.files?.[0]);
                  e.target.value = ""; // Allow picking the same file again.
                }}
              />
              <Tooltip label="Import JSON or HAR">
                <Button variant="ghost" size="icon" aria-label="Import JSON or HAR" onClick={() => importInput.current?.click()}>
                  <Upload className="size-4" />
                </Button>
              </Tooltip>
              <Tooltip label="Export as JSON">
                <a href={exportUrl(endpoint.id)} aria-label="Export as JSON">
                  <Button variant="ghost" size="icon" tabIndex={-1}>
                    <Download className="size-4" />
                  </Button>
                </a>
              </Tooltip>
              <Tooltip label="Export as HAR">
                <a href={exportUrl(endpoint.id, "har")} aria-label="Export as HAR">
                  <Button variant="ghost" size="icon" tabIndex={-1}>
                    <FileDown className="size-4" />
                  </Button>
                </a>
              </Tooltip>
              <Tooltip label="Refresh">
                <Button variant="ghost" size="icon" aria-label="Refresh" onClick={reload}>
                  <RefreshCw className="size-4" />
                </Button>
              </Tooltip>
              <Tooltip label="Clear all requests">
                <Button
                  variant="danger"
                  size="icon"
                  aria-label="Clear all requests"
                  onClick={async () => {
                    await api.clearRequests(endpoint.id);
                    await reload();
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </Tooltip>
            </div>
          </div>
          <div className="flex gap-2 border-b border-zinc-800 px-4 py-2">
            <select
              className={cx(inputClass, "h-8 px-2")}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              aria-label="Filter by method"
            >
              <option value="">All</option>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <div className={cx(inputClass, "flex h-8 flex-1 items-center gap-2 focus-within:border-sky-500")}>
              <Search className="size-3.5 shrink-0 text-zinc-500" />
              <input
                className="min-w-0 flex-1 bg-transparent focus:outline-none"
                placeholder="Search path, headers, body"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search requests"
              />
              {search && (
                <button type="button" title="Clear search" onClick={() => setSearch("")}>
                  <X className="size-3.5 text-zinc-500 hover:text-zinc-200" />
                </button>
              )}
            </div>
          </div>
          {compare && (
            <p className="border-b border-zinc-800 bg-sky-500/10 px-4 py-2 text-xs text-sky-300">
              Select two requests to compare ({compare.length}/2).
            </p>
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {requests.length === 0 && (
              <li className="p-6 text-center text-sm text-zinc-500">
                {filtered ? "No requests match the search." : "Waiting for the first request…"}
              </li>
            )}
            {requests.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => (compare ? toggleCompare(r.id) : setSelectedId(r.id))}
                  className={cx(
                    "flex w-full flex-col gap-1.5 border-b border-l-2 border-b-zinc-800/60 px-4 py-3 text-left transition-colors",
                    (compare ? compare.includes(r.id) : r.id === selectedId)
                      ? "border-l-sky-500 bg-zinc-800/50"
                      : "border-l-transparent hover:bg-zinc-800/30",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      {compare && (
                        <input
                          type="checkbox"
                          readOnly
                          tabIndex={-1}
                          checked={compare.includes(r.id)}
                          className="accent-sky-500"
                        />
                      )}
                      <MethodBadge method={r.method} />
                      {r.forward && (
                        <span className="flex items-center gap-1 text-zinc-500" title={`Forwarded to ${r.forward.url}`}>
                          <Forward className="size-3.5" />
                          <StatusBadge status={r.forward.status} error={r.forward.error} />
                        </span>
                      )}
                    </span>
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
          {compare?.length === 2 ? (
            <RequestDiff ids={compare as [string, string]} onClose={() => setCompare(null)} />
          ) : selectedId ? (
            <RequestDetail
              key={selectedId}
              id={selectedId}
              endpointId={endpoint.id}
              forward={requests.find((r) => r.id === selectedId)?.forward ?? null}
              onDeleted={reload}
            />
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

type RuleDraft = Omit<ResponseRule, "status" | "delayMs"> & { status: string; delayMs: string };

const FORWARD_MODE_LABELS: Record<(typeof FORWARD_MODES)[number], string> = {
  async: "Background: the sender gets the response set here",
  proxy: "Proxy: the sender gets the target's response",
};

const newRule = (): RuleDraft => ({
  method: "",
  path: "",
  status: "500",
  contentType: "application/json",
  body: '{"error":"test failure"}',
  delayMs: "0",
});

function EndpointSettings({ endpoint, onSaved }: { endpoint: Endpoint; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: endpoint.name,
    responseStatus: String(endpoint.responseStatus),
    responseContentType: endpoint.responseContentType,
    responseBody: endpoint.responseBody,
    responseDelayMs: String(endpoint.responseDelayMs),
    forwardUrl: endpoint.forwardUrl,
    forwardMode: endpoint.forwardMode,
    signatureScheme: endpoint.signatureScheme,
  });
  const [custom, setCustom] = useState(endpoint.signatureCustom);
  /** Null keeps the saved secret, which the API does not return until "Show" is clicked. */
  const [secret, setSecret] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleDraft[]>(() =>
    endpoint.responseRules.map((r) => ({ ...r, status: String(r.status), delayMs: String(r.delayMs) })),
  );
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const setRule = (i: number, k: keyof RuleDraft) => (e: { target: { value: string } }) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));

  return (
    <form
      className="flex flex-col gap-6 border-t border-zinc-800 pt-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.updateEndpoint(endpoint.id, {
            ...form,
            responseStatus: Number(form.responseStatus),
            responseDelayMs: Number(form.responseDelayMs || 0),
            responseRules: rules.map((r) => ({ ...r, status: Number(r.status), delayMs: Number(r.delayMs || 0) })),
            // Sent only for the custom scheme, so a stale header does not block saving other settings.
            ...(form.signatureScheme === "custom" && { signatureCustom: custom }),
            ...(secret !== null && { signatureSecret: secret }),
          });
          onSaved();
        } catch (err) {
          setError(String(err));
        }
      }}
    >
      <SettingsSection title="Default response">
        <div className="grid gap-4 md:grid-cols-[1fr_120px_1fr_120px]">
          <Field label="Name">
            <input className={cx(inputClass, "h-10")} value={form.name} onChange={set("name")} />
          </Field>
          <Field label="Status">
            <input className={cx(inputClass, "h-10")} value={form.responseStatus} onChange={set("responseStatus")} inputMode="numeric" />
          </Field>
          <Field label="Content type">
            <input className={cx(inputClass, "h-10")} value={form.responseContentType} onChange={set("responseContentType")} />
          </Field>
          <Field label="Delay (ms)">
            <input className={cx(inputClass, "h-10")} value={form.responseDelayMs} onChange={set("responseDelayMs")} inputMode="numeric" />
          </Field>
          <div className="md:col-span-4">
            <Field label="Response body">
              <textarea className={cx(inputClass, "h-24 py-2")} value={form.responseBody} onChange={set("responseBody")} />
            </Field>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Response rules"
        hint="The first rule that matches the method and subpath gives the response. Use * in a path, e.g. /orders/*."
      >
        {rules.map((r, i) => (
          <div key={i} className="grid gap-3 rounded-lg border border-zinc-800 p-3 md:grid-cols-[110px_1fr_90px_1fr_100px_auto]">
            <Field label="Method">
              <select className={cx(inputClass, "h-9")} value={r.method} onChange={setRule(i, "method")}>
                <option value="">Any</option>
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Path">
              <input className={cx(inputClass, "h-9")} placeholder="Any" value={r.path} onChange={setRule(i, "path")} />
            </Field>
            <Field label="Status">
              <input className={cx(inputClass, "h-9")} value={r.status} onChange={setRule(i, "status")} inputMode="numeric" />
            </Field>
            <Field label="Content type">
              <input className={cx(inputClass, "h-9")} value={r.contentType} onChange={setRule(i, "contentType")} />
            </Field>
            <Field label="Delay (ms)">
              <input className={cx(inputClass, "h-9")} value={r.delayMs} onChange={setRule(i, "delayMs")} inputMode="numeric" />
            </Field>
            <Button
              variant="danger"
              size="icon"
              type="button"
              className="self-end md:mb-0.5"
              title="Remove rule"
              onClick={() => setRules(rules.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-4" />
            </Button>
            <div className="md:col-span-6">
              <Field label="Body">
                <textarea className={cx(inputClass, "h-16 py-2")} value={r.body} onChange={setRule(i, "body")} />
              </Field>
            </div>
          </div>
        ))}
        <Button size="sm" type="button" className="self-start" onClick={() => setRules([...rules, newRule()])}>
          <Plus className="size-4" /> Add rule
        </Button>
      </SettingsSection>

      <div className="grid gap-6 md:grid-cols-2">
        <SettingsSection
          title="Auto-forward"
          hint="Each request is also sent to this URL, with its subpath and query added. Leave empty to turn off."
        >
          <input
            className={cx(inputClass, "h-10")}
            placeholder="http://host.docker.internal:3000/webhooks"
            value={form.forwardUrl}
            onChange={set("forwardUrl")}
          />
          <select
            className={cx(inputClass, "h-10")}
            value={form.forwardMode}
            onChange={set("forwardMode")}
            disabled={!form.forwardUrl.trim()}
            aria-label="Forward mode"
          >
            {FORWARD_MODES.map((m) => (
              <option key={m} value={m}>
                {FORWARD_MODE_LABELS[m]}
              </option>
            ))}
          </select>
          {form.forwardMode === "proxy" && (
            <p className="text-xs text-zinc-500">
              A matching response rule still wins. If the target cannot be reached, the sender gets 502.
            </p>
          )}
        </SettingsSection>

        <SettingsSection title="Signature check" hint="Each request shows if its signature matches the secret.">
          <div className="grid gap-3 md:grid-cols-2">
            <select className={cx(inputClass, "h-10")} value={form.signatureScheme} onChange={set("signatureScheme")}>
              <option value="">Off</option>
              {SIGNATURE_SCHEMES.map((s) => (
                <option key={s} value={s}>
                  {SCHEME_LABELS[s]}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <input
                className={cx(inputClass, "h-10 min-w-0 flex-1")}
                placeholder={endpoint.signatureSecretSet ? "Saved (hidden). Type to replace." : "Signing secret"}
                value={secret ?? ""}
                onChange={(e) => setSecret(e.target.value)}
                disabled={!form.signatureScheme}
                autoComplete="off"
              />
              {endpoint.signatureSecretSet && secret === null && (
                <Button
                  size="sm"
                  type="button"
                  className="h-10"
                  disabled={!form.signatureScheme}
                  onClick={async () => setSecret((await api.getSignatureSecret(endpoint.id)).signatureSecret)}
                >
                  Show
                </Button>
              )}
            </div>
          </div>
          {form.signatureScheme === "custom" && <CustomSignatureFields value={custom} onChange={setCustom} mode="verify" />}
        </SettingsSection>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" type="submit">
          Save
        </Button>
        {error && <span className="text-sm text-rose-400">{error}</span>}
      </div>
    </form>
  );
}

function SettingsSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-zinc-500">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
