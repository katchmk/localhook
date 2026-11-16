import { Braces, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HeaderPair, SavedRequest, SentRequest } from "./api";
import { Button, cx, MethodBadge, Panel, StatusBadge, Tabs, timeAgo, useNow } from "./ui";

type View = "history" | "saved" | "variables";

const itemClass = (selected: boolean) =>
  cx(
    "flex w-full flex-col gap-1.5 border-b border-l-2 border-b-zinc-800/60 px-4 py-3 text-left hover:bg-zinc-800/30",
    selected ? "border-l-sky-500 bg-zinc-800/50" : "border-l-transparent",
  );

export function SenderSidebar({
  history,
  selectedSentId,
  onLoadSent,
  onClearHistory,
  saved,
  selectedSavedId,
  onLoadSaved,
  onDeleteSaved,
  variables,
  onSaveVariables,
}: {
  history: SentRequest[];
  selectedSentId: string | null;
  onLoadSent: (s: SentRequest) => void;
  onClearHistory: () => void;
  saved: SavedRequest[];
  selectedSavedId: string | null;
  onLoadSaved: (s: SavedRequest) => void;
  onDeleteSaved: (s: SavedRequest) => void;
  variables: HeaderPair[];
  onSaveVariables: (variables: HeaderPair[]) => Promise<void>;
}) {
  const [view, setView] = useState<View>("history");
  const now = useNow();

  // Group by collection; the server sorts by collection, then name.
  const collections = new Map<string, SavedRequest[]>();
  for (const s of saved) collections.set(s.collection, [...(collections.get(s.collection) ?? []), s]);

  return (
    <Panel className="flex min-h-0 flex-col">
      {/* min-w-0 lets the tab row shrink instead of pushing the panel wider. */}
      <div className="min-w-0 overflow-x-auto px-4 pt-2">
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { id: "history", label: "History", count: history.length },
            { id: "saved", label: "Saved", count: saved.length },
            { id: "variables", label: "Variables", count: variables.length },
          ]}
        />
      </div>

      {view === "history" && history.length > 0 && (
        <div className="flex justify-end border-b border-zinc-800/60 px-2 py-1">
          <Button variant="danger" size="sm" className="h-7 px-2 text-xs" onClick={onClearHistory}>
            <Trash2 className="size-3.5" /> Clear history
          </Button>
        </div>
      )}

      {view === "history" && (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {history.length === 0 && <li className="p-6 text-center text-sm text-zinc-500">No requests sent yet.</li>}
          {history.map((s) => (
            <li key={s.id}>
              <button onClick={() => onLoadSent(s)} className={itemClass(selectedSentId === s.id)}>
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
      )}

      {view === "saved" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {saved.length === 0 && (
            <p className="p-6 text-center text-sm text-zinc-500">No saved requests. Use Save in the editor.</p>
          )}
          {[...collections].map(([collection, items]) => (
            <section key={collection}>
              <h3 className="border-b border-zinc-800/60 bg-zinc-900/60 px-4 py-1.5 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
                {collection}
              </h3>
              <ul>
                {items.map((s) => (
                  <li key={s.id} className="group relative">
                    <button onClick={() => onLoadSaved(s)} className={itemClass(selectedSavedId === s.id)}>
                      <div className="flex items-center gap-2 pr-8">
                        <MethodBadge method={s.request.method} />
                        <span className="truncate text-sm text-zinc-200">{s.name}</span>
                      </div>
                      <span className="truncate font-mono text-xs text-zinc-500">{s.request.url}</span>
                    </button>
                    <Button
                      variant="danger"
                      size="icon"
                      title="Delete saved request"
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => onDeleteSaved(s)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {view === "variables" && <VariablesEditor variables={variables} onSave={onSaveVariables} />}
    </Panel>
  );
}

const clean = (rows: HeaderPair[]) => rows.filter(([k]) => k.trim()).map(([k, v]): HeaderPair => [k.trim(), v]);

function VariablesEditor({
  variables,
  onSave,
}: {
  variables: HeaderPair[];
  onSave: (variables: HeaderPair[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<HeaderPair[]>(variables);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const newRow = useRef<HTMLInputElement>(null);
  const added = useRef(false);
  useEffect(() => setRows(variables), [variables]);

  // Focus the name of a row that "Add variable" just made.
  useEffect(() => {
    if (added.current) newRow.current?.focus();
    added.current = false;
  }, [rows.length]);

  const dirty = JSON.stringify(clean(rows)) !== JSON.stringify(variables);
  const names = rows.map(([k]) => k.trim()).filter(Boolean);
  const duplicates = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const update = (i: number, pos: 0 | 1, value: string) => {
    setRows(rows.map((r, j) => (j === i ? (pos === 0 ? [value, r[1]] : [r[0], value]) : r)));
    setError(null);
  };
  const add = () => {
    added.current = true;
    setRows([...rows, ["", ""]]);
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSave(clean(rows));
        } catch (err) {
          setError(String(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-xs leading-relaxed text-zinc-500">
          Write <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">{"{{name}}"}</code> in a request.
          The value is filled in when it is sent.
        </p>

        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-zinc-800 px-4 py-8 text-center">
            <Braces className="size-6 text-zinc-600" />
            <p className="text-sm text-zinc-400">No variables yet.</p>
            <Button size="sm" type="button" onClick={add}>
              <Plus className="size-4" /> Add variable
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
            {rows.map(([name, value], i) => {
              const duplicate = duplicates.has(name.trim());
              return (
                <li key={i} className="group flex items-stretch">
                  <label
                    className={cx(
                      "flex w-2/5 min-w-0 items-center border-r border-zinc-800 pl-2 font-mono text-[13px]",
                      duplicate ? "text-amber-400" : "text-sky-300",
                    )}
                    title={duplicate ? "This name is used more than once; the last value wins" : undefined}
                  >
                    <span className="text-zinc-600 select-none">{"{{"}</span>
                    <input
                      ref={i === rows.length - 1 ? newRow : undefined}
                      // Grows with the text, so the closing braces stay next to the name.
                      className="field-sizing-content h-9 max-w-full min-w-[4ch] bg-transparent px-0.5 placeholder:text-zinc-600 focus:outline-none"
                      placeholder="name"
                      value={name}
                      onChange={(e) => update(i, 0, e.target.value.replace(/[{}\s]/g, ""))}
                      aria-label="Variable name"
                      spellCheck={false}
                    />
                    <span className="pr-2 text-zinc-600 select-none">{"}}"}</span>
                  </label>
                  <input
                    className="h-9 min-w-0 flex-1 bg-transparent px-2.5 font-mono text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:bg-zinc-900 focus:outline-none"
                    placeholder="value"
                    value={value}
                    onChange={(e) => update(i, 1, e.target.value)}
                    aria-label={`Value of ${name || "variable"}`}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    title="Remove variable"
                    className="px-2 text-zinc-600 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 hover:text-rose-400 focus-visible:opacity-100"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3">
        {rows.length > 0 && (
          <Button size="sm" variant="ghost" type="button" className="-ml-2" onClick={add}>
            <Plus className="size-4" /> Add
          </Button>
        )}
        <span className={cx("ml-auto text-xs", error ? "text-rose-400" : "text-zinc-500")}>
          {error ?? (dirty ? "Unsaved changes" : "")}
        </span>
        <Button variant="primary" size="sm" type="submit" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
