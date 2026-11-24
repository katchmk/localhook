import { ClipboardPaste, FileUp, Info, Save, Send, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  DEFAULT_CUSTOM_SIGNATURE,
  SIGNATURE_SCHEMES,
  type HeaderPair,
  type OutgoingSignature,
  type SenderAuth,
  type SentRequest,
} from "./api";
import { parseCurl } from "./curl";
import { fetchRequest, useEndpoints, useSenderData, useSenderMutations } from "./queries";
import { draftFromCaptured, draftFromCurl, draftToSaved, toSendInput, unknownVariables, type Draft } from "./senderDraft";
import { SenderSidebar } from "./SenderSidebar";
import { initialSenderState, senderReducer } from "./senderState";
import {
  Button,
  CodeView,
  CopyButton,
  CustomSignatureFields,
  cx,
  Field,
  formatBytes,
  inputClass,
  KeyValueTable,
  PairEditor,
  Panel,
  parseSetCookies,
  prettyJson,
  SCHEME_NAMES,
  Segmented,
  StatusBadge,
  Tabs,
  toCurl,
} from "./ui";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

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

/** A default name for a saved request, e.g. "POST /orders". */
function defaultName(d: Draft) {
  const path = URL.parse(d.url)?.pathname ?? d.url;
  return `${d.method} ${path}`;
}

/** `fromRequestId` loads a captured request into the editor. */
export function Sender({ fromRequestId }: { fromRequestId: string | null }) {
  const [state, dispatch] = useReducer(senderReducer, undefined, initialSenderState);
  const { draft, current, response, error, tab, showImport } = state;
  const { history, saved, variables } = useSenderData();
  const mutations = useSenderMutations();
  const qc = useQueryClient();
  const { data: endpoints } = useEndpoints();
  const busy = mutations.send.isPending;
  const setDraft = (next: Draft | ((d: Draft) => Draft)) =>
    dispatch({ type: "draftUpdated", update: typeof next === "function" ? next : () => next });
  const fail = (e: unknown) => dispatch({ type: "failed", error: String(e) });

  useEffect(() => {
    if (!fromRequestId) return;
    fetchRequest(qc, fromRequestId).then((r) => dispatch({ type: "unsavedLoaded", draft: draftFromCaptured(r) }), fail);
    // Drop the id from the URL, so a page reload does not replace later edits.
    window.history.replaceState(null, "", "#/sender");
  }, [fromRequestId, qc]);

  // Default the target to the first local endpoint, so a first send shows up in the Receiver.
  const firstEndpoint = endpoints?.[0]?.id;
  useEffect(() => {
    if (!fromRequestId && firstEndpoint)
      dispatch({ type: "defaultUrlFound", url: `http://localhost:8080/hook/${firstEndpoint}` });
  }, [fromRequestId, firstEndpoint]);

  const unknown = unknownVariables(draft, variables);

  const send = () => {
    dispatch({ type: "sendStarted" });
    mutations.send.mutate(toSendInput(draft, variables), {
      onSuccess: (res) => dispatch({ type: "responseReceived", response: res }),
      onError: fail,
    });
  };

  const save = async (asNew: boolean) => {
    const request = draftToSaved(draft);
    try {
      if (current && !asNew) {
        dispatch({ type: "savedStored", saved: await mutations.updateSaved.mutateAsync({ id: current.id, request }) });
        return;
      }
      const name = prompt("Name of the saved request", current?.name ?? defaultName(draft));
      if (!name?.trim()) return;
      const collection = prompt("Collection", current?.collection ?? "Default");
      if (collection === null) return;
      const created = await mutations.createSaved.mutateAsync({ collection: collection.trim() || "Default", name, request });
      dispatch({ type: "savedStored", saved: created });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
      <SenderSidebar
        history={history}
        selectedSentId={response?.id ?? null}
        onLoadSent={(sent) => dispatch({ type: "sentLoaded", sent })}
        onClearHistory={() => mutations.clearHistory.mutate()}
        saved={saved}
        selectedSavedId={current?.id ?? null}
        onLoadSaved={(s) => dispatch({ type: "savedLoaded", saved: s })}
        onDeleteSaved={(s) => {
          if (!confirm(`Delete the saved request "${s.name}"?`)) return;
          mutations.deleteSaved.mutate(s, { onSuccess: () => dispatch({ type: "savedDeleted", id: s.id }) });
        }}
        variables={variables}
        onSaveVariables={async (v) => void (await mutations.setVariables.mutateAsync(v))}
      />

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <Panel className="flex flex-col gap-4 p-5">
          {current && (
            <div className="-mb-1 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-500">{current.collection} /</span>
              <span className="font-semibold">{current.name}</span>
              <button type="button" className="text-sky-400 hover:underline" onClick={() => save(true)}>
                Save as new
              </button>
              <Button variant="ghost" size="icon" title="Stop editing this saved request" onClick={() => dispatch({ type: "currentCleared" })}>
                <X className="size-4" />
              </Button>
            </div>
          )}
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
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
              className={cx(inputClass, "h-10 min-w-48 flex-1")}
              placeholder="https://example.com/webhook or {{baseUrl}}/webhook"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              required
            />
            <Button variant="primary" type="submit" disabled={busy}>
              <Send className="size-4" /> {busy ? "Sending…" : "Send"}
            </Button>
            <Button type="button" title={current ? "Save changes" : "Save this request"} onClick={() => save(false)}>
              <Save className="size-4" /> Save
            </Button>
            <CopyButton text={toCurl(toSendInput(draft, variables))} label="cURL" className="h-10" />
            <Button
              type="button"
              variant={showImport ? "primary" : "secondary"}
              size="icon"
              className="size-10"
              title="Import a cURL command"
              onClick={() => dispatch({ type: "importToggled" })}
            >
              <ClipboardPaste className="size-4" />
            </Button>
          </form>
          {showImport && (
            <CurlImport
              onImport={(d) => dispatch({ type: "curlImported", draft: d })}
            />
          )}
          <p className="-mt-2 text-xs text-zinc-500">
            The server sends the request, so CORS does not apply. Inside Docker, <code>localhost</code> is the
            container itself; use <code>host.docker.internal</code> to reach services on your computer.
          </p>
          {unknown.length > 0 && (
            <p className="-mt-2 text-xs text-amber-400">
              No value for {unknown.map((n) => `{{${n}}}`).join(", ")}. Add it in Variables, or it is sent as it is.
            </p>
          )}
          {error && <p className="text-sm text-rose-400">{error}</p>}

          <Tabs
            value={tab}
            onChange={(t) => dispatch({ type: "tabChanged", tab: t })}
            tabs={[
              { id: "body", label: "Body" },
              { id: "auth", label: draft.auth.type === "none" ? "Auth" : `Auth (${AUTH_LABELS[draft.auth.type]})` },
              { id: "signature", label: draft.sign ? `Signature (${SCHEME_NAMES[draft.sign.scheme]})` : "Signature" },
              { id: "headers", label: "Headers", count: draft.headers.filter(([k]) => k.trim()).length },
              { id: "cookies", label: "Cookies", count: draft.cookies.filter(([k]) => k.trim()).length },
            ]}
          />
          {tab === "body" ? (
            <BodyEditor draft={draft} setDraft={setDraft} />
          ) : tab === "auth" ? (
            <AuthEditor auth={draft.auth} onChange={(auth) => setDraft({ ...draft, auth })} />
          ) : tab === "signature" ? (
            <SignEditor sign={draft.sign} onChange={(sign) => setDraft({ ...draft, sign })} />
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

function CurlImport({ onImport }: { onImport: (d: Draft) => void }) {
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 p-3">
      <textarea
        className={cx(inputClass, "h-28 py-2")}
        placeholder={"curl -X POST https://example.com/webhook -H 'Content-Type: application/json' -d '{\"a\":1}'"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          type="button"
          disabled={!text.trim()}
          onClick={() => {
            try {
              const parsed = parseCurl(text);
              onImport(draftFromCurl(parsed));
              if (parsed.warnings.length) alert(`Imported with notes:\n- ${parsed.warnings.join("\n- ")}`);
            } catch (e) {
              setMessage((e as Error).message);
            }
          }}
        >
          Import
        </Button>
        <span className="text-xs text-zinc-500">The command replaces the request in the editor.</span>
        {message && <span className="text-sm text-rose-400">{message}</span>}
      </div>
    </div>
  );
}

// The headers that each built-in scheme adds.
const SCHEME_HEADERS: Record<Exclude<OutgoingSignature["scheme"], "custom">, string[]> = {
  github: ["X-Hub-Signature-256"],
  stripe: ["Stripe-Signature"],
  shopify: ["X-Shopify-Hmac-Sha256"],
  slack: ["X-Slack-Request-Timestamp", "X-Slack-Signature"],
  standard: ["webhook-id", "webhook-timestamp", "webhook-signature"],
};

function SignEditor({ sign, onChange }: { sign: OutgoingSignature | null; onChange: (s: OutgoingSignature | null) => void }) {
  // Keep the last settings while signing is off, so turning it on again restores them.
  const last = useRef<OutgoingSignature>(sign ?? { scheme: "github", secret: "", custom: DEFAULT_CUSTOM_SIGNATURE });
  if (sign) last.current = sign;
  const value = last.current;

  return (
    <div className="flex flex-col gap-4">
      <Field label="Scheme" group>
        <Segmented
          value={sign ? sign.scheme : "off"}
          options={[
            { value: "off", label: "Off" },
            ...SIGNATURE_SCHEMES.map((s) => ({ value: s, label: SCHEME_NAMES[s] })),
          ]}
          onChange={(scheme) => onChange(scheme === "off" ? null : { ...value, scheme })}
        />
      </Field>

      {!sign ? (
        <p className="text-sm text-zinc-500">Sign the request like a webhook provider does, to test your own signature checks.</p>
      ) : (
        <>
          <Field label="Secret" className="max-w-xl">
            <input
              className={cx(inputClass, "h-9")}
              value={sign.secret}
              placeholder={sign.scheme === "standard" ? "whsec_… or {{variable}}" : "Signing secret or {{variable}}"}
              onChange={(e) => onChange({ ...sign, secret: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            {!sign.secret && (
              <span className="text-xs text-amber-400">The secret is empty, so the signature uses an empty key.</span>
            )}
          </Field>

          {sign.scheme === "custom" ? (
            <CustomSignatureFields value={sign.custom} onChange={(custom) => onChange({ ...sign, custom })} mode="sign" />
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
              Adds
              {SCHEME_HEADERS[sign.scheme].map((h) => (
                <code key={h} className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-300">
                  {h}
                </code>
              ))}
            </div>
          )}

          <p className="flex items-start gap-2 text-xs text-zinc-500">
            <Info className="mt-px size-3.5 shrink-0" />
            The server signs the final body when it sends. Headers with the same names are replaced. Copy as cURL does
            not include the signature.
          </p>
        </>
      )}
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
      <Segmented
        value={draft.bodyMode}
        options={[
          { value: "text", label: "Text" },
          { value: "file", label: "Binary file" },
        ]}
        onChange={(bodyMode) => setDraft((d) => ({ ...d, bodyMode }))}
      />
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

const AUTH_LABELS: Record<SenderAuth["type"], string> = {
  none: "None",
  basic: "Basic",
  bearer: "Bearer token",
  apikey: "API key",
};

function AuthEditor({ auth, onChange }: { auth: SenderAuth; onChange: (auth: SenderAuth) => void }) {
  const set = (k: keyof SenderAuth) => (e: { target: { value: string } }) => onChange({ ...auth, [k]: e.target.value });
  return (
    <div className="flex flex-col gap-4">
      <Segmented
        value={auth.type}
        options={(Object.keys(AUTH_LABELS) as SenderAuth["type"][]).map((type) => ({ value: type, label: AUTH_LABELS[type] }))}
        onChange={(type) => onChange({ ...auth, type })}
      />
      {auth.type === "none" && <p className="text-sm text-zinc-500">The request has no auth, other than headers you add.</p>}
      {auth.type === "basic" && (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Username">
            <input className={cx(inputClass, "h-9")} value={auth.username} onChange={set("username")} autoComplete="off" />
          </Field>
          <Field label="Password">
            <input
              className={cx(inputClass, "h-9")}
              type="password"
              value={auth.password}
              onChange={set("password")}
              autoComplete="off"
            />
          </Field>
        </div>
      )}
      {auth.type === "bearer" && (
        <Field label="Token">
          <input className={cx(inputClass, "h-9")} value={auth.token} onChange={set("token")} autoComplete="off" />
        </Field>
      )}
      {auth.type === "apikey" && (
        <div className="grid gap-3 md:grid-cols-[1fr_2fr_140px]">
          <Field label="Name">
            <input className={cx(inputClass, "h-9")} value={auth.key} onChange={set("key")} />
          </Field>
          <Field label="Value">
            <input className={cx(inputClass, "h-9")} value={auth.value} onChange={set("value")} autoComplete="off" />
          </Field>
          <Field label="Add to">
            <select className={cx(inputClass, "h-9")} value={auth.in} onChange={set("in")}>
              <option value="header">Header</option>
              <option value="query">Query</option>
            </select>
          </Field>
        </div>
      )}
      {auth.type !== "none" && (
        <p className="text-xs text-zinc-500">
          Added when the request is sent. It replaces a header with the same name. The Sender history keeps the
          values as sent.
        </p>
      )}
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
