import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type CapturedRequest } from "./api";
import { Button, cx, MethodBadge, prettyJson } from "./ui";

type Line = { kind: " " | "-" | "+"; text: string };

// The LCS table has (a.length + 1) * (b.length + 1) cells; above this the diff is too slow.
const MAX_CELLS = 4_000_000;

/** Line diff by longest common subsequence. Returns null when the inputs are too large. */
function diffLines(a: string[], b: string[]): Line[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) return null;

  // lcs[i * w + j] is the LCS length of midA[i..] and midB[j..].
  const w = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * w);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }

  const out: Line[] = a.slice(0, start).map((text) => ({ kind: " ", text }));
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      out.push({ kind: " ", text: midA[i++]! }), j++;
    } else if (i < midA.length && (j === midB.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      out.push({ kind: "-", text: midA[i++]! });
    } else {
      out.push({ kind: "+", text: midB[j++]! });
    }
  }
  return out.concat(a.slice(endA).map((text) => ({ kind: " ", text })));
}

const sections = (r: CapturedRequest) => ({
  Request: [`${r.method} ${r.path}${r.query}`],
  Headers: r.headers.map(([k, v]) => `${k}: ${v}`).sort(),
  Body: (r.bodyEncoding === "utf8" ? (prettyJson(r.body) ?? r.body) : `base64: ${r.body}`).split("\n"),
});

/** Shows the differences between two captured requests. The older one is the "-" side. */
export function RequestDiff({ ids, onClose }: { ids: [string, string]; onClose: () => void }) {
  const [pair, setPair] = useState<[CapturedRequest, CapturedRequest] | null>(null);

  useEffect(() => {
    Promise.all(ids.map((id) => api.getRequest(id))).then(([a, b]) =>
      setPair(a!.createdAt <= b!.createdAt ? [a!, b!] : [b!, a!]),
    );
  }, [ids[0], ids[1]]);

  if (!pair) return null;
  const [older, newer] = pair;
  const left = sections(older);
  const right = sections(newer);

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Compare requests</h2>
        <div className="ml-auto">
          <Button variant="ghost" size="icon" title="Close compare" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1 font-mono text-sm">
        {[
          { r: older, sign: "-", color: "text-rose-400" },
          { r: newer, sign: "+", color: "text-emerald-400" },
        ].map(({ r, sign, color }) => (
          <div key={r.id} className="flex items-center gap-2">
            <span className={cx("w-3 font-bold", color)}>{sign}</span>
            <MethodBadge method={r.method} />
            <span className="truncate">{r.path}</span>
            <span className="ml-auto text-xs text-zinc-500">{new Date(r.createdAt).toLocaleString()}</span>
          </div>
        ))}
      </div>
      {(Object.keys(left) as (keyof typeof left)[]).map((name) => (
        <DiffSection key={name} title={name} lines={diffLines(left[name], right[name])} />
      ))}
    </div>
  );
}

// Unchanged runs longer than this are folded, keeping CONTEXT lines on each side.
const CONTEXT = 3;

function DiffSection({ title, lines }: { title: string; lines: Line[] | null }) {
  const changed = lines?.filter((l) => l.kind !== " ").length ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
        {title}
        <span className="rounded-full bg-zinc-800 px-1.5 text-[11px] normal-case">
          {lines === null ? "too large" : changed === 0 ? "same" : `${changed} changed`}
        </span>
      </div>
      {lines && (
        <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 py-2 font-mono text-[13px]">
          {fold(lines).map((l, i) =>
            l === null ? (
              <div key={i} className="px-4 text-zinc-600">
                …
              </div>
            ) : (
              <div
                key={i}
                className={cx(
                  "px-4 whitespace-pre-wrap break-all",
                  l.kind === "+" && "bg-emerald-500/10 text-emerald-300",
                  l.kind === "-" && "bg-rose-500/10 text-rose-300",
                  l.kind === " " && "text-zinc-400",
                )}
              >
                {l.kind} {l.text}
              </div>
            ),
          )}
        </pre>
      )}
    </div>
  );
}

/** Replaces long unchanged runs with null, keeping CONTEXT lines next to each change. */
function fold(lines: Line[]): (Line | null)[] {
  const near = (i: number) =>
    lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((l) => l.kind !== " ");
  if (!lines.some((l) => l.kind !== " ")) return lines;
  const out: (Line | null)[] = [];
  lines.forEach((l, i) => {
    if (l.kind !== " " || near(i)) out.push(l);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}
