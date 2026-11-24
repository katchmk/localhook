import { QueryClient, keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  api,
  DOMAIN_PROVIDER,
  streamUrl,
  type CapturedRequestSummary,
  type Endpoint,
  type HeaderPair,
  type SavedRequest,
  type TunnelInfo,
} from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1 },
  },
});

export type RequestFilter = { q: string; method: string };

export const keys = {
  endpoints: ["endpoints"] as const,
  /** All request lists of an endpoint, for every filter. */
  requests: (endpointId: string) => ["endpoints", endpointId, "requests"] as const,
  requestList: (endpointId: string, filter: RequestFilter) => [...keys.requests(endpointId), filter] as const,
  request: (id: string) => ["request", id] as const,
  tunnel: ["tunnel"] as const,
  sent: ["sent"] as const,
  saved: ["saved"] as const,
  variables: ["variables"] as const,
};

const NO_FILTER: RequestFilter = { q: "", method: "" };
const isFiltered = (f: RequestFilter) => !!(f.q || f.method);

/** The endpoints. The server always has one: when the list is empty, a "Default" endpoint is made. */
export function useEndpoints() {
  return useQuery({
    queryKey: keys.endpoints,
    queryFn: async () => {
      const list = await api.listEndpoints();
      return list.length > 0 ? list : [await api.createEndpoint({ name: "Default" })];
    },
  });
}

export function useRequests(endpointId: string, filter: RequestFilter) {
  return useQuery({
    queryKey: keys.requestList(endpointId, filter),
    queryFn: () => api.listRequests(endpointId, filter),
    // Keep the old list on screen while a new search loads.
    placeholderData: keepPreviousData,
  });
}

/** The tunnel. Polls while the tunnel starts. */
export function useTunnel() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.tunnel,
    queryFn: api.getTunnel,
    refetchInterval: (q) => (q.state.data?.state?.status === "starting" ? 1500 : false),
  });
  const save = (info: TunnelInfo) => qc.setQueryData(keys.tunnel, info);

  /** Starts the named provider; an empty name stops the tunnel. */
  const choose = useMutation({ mutationFn: api.setTunnel, onSuccess: save, onError: alertError });

  /** Saves the own-domain settings and starts that tunnel. An empty hostname removes them. */
  const saveDomain = useMutation({
    mutationFn: async ({ hostname, token }: { hostname: string; token: string }) => {
      save(await api.setTunnelDomain({ hostname, token: token || undefined }));
      return hostname.trim() ? api.setTunnel(DOMAIN_PROVIDER) : null;
    },
    onSuccess: (info) => info && save(info),
    onError: alertError,
  });

  return { info: query.data ?? null, choose, saveDomain };
}

/**
 * Listens to the live stream of an endpoint and puts each request into the cache.
 * Returns true while the stream is connected.
 */
export function useRequestStream(endpointId: string, onRequest?: (req: CapturedRequestSummary) => void) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const onRequestRef = useLatest(onRequest);

  useEffect(() => {
    const es = new EventSource(streamUrl(endpointId));
    let connectedBefore = false;
    es.addEventListener("ready", () => {
      setLive(true);
      // Requests can arrive while the stream reconnects, so load the lists again.
      if (connectedBefore) void qc.invalidateQueries({ queryKey: keys.requests(endpointId) });
      connectedBefore = true;
    });
    es.addEventListener("request", (e) => {
      const req = JSON.parse((e as MessageEvent).data) as CapturedRequestSummary;
      onRequestRef.current?.(req);
      // A known id is an update, e.g. a forward result; keep its place in the list.
      qc.setQueryData<CapturedRequestSummary[]>(keys.requestList(endpointId, NO_FILTER), (cur) =>
        cur && (cur.some((r) => r.id === req.id) ? cur.map((r) => (r.id === req.id ? req : r)) : [req, ...cur]),
      );
      // The summary has no headers or body, so only the server can tell if it matches a search.
      void qc.invalidateQueries({
        queryKey: keys.requests(endpointId),
        predicate: (q) => isFiltered(q.queryKey[3] as RequestFilter),
      });
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [endpointId, qc, onRequestRef]);

  return live;
}

export function useEndpointMutations(endpointId: string) {
  const qc = useQueryClient();
  const refreshEndpoints = () => qc.invalidateQueries({ queryKey: keys.endpoints });
  const refreshRequests = () => qc.invalidateQueries({ queryKey: keys.requests(endpointId) });

  return {
    refreshRequests,
    create: useMutation({
      mutationFn: (id: string | undefined) => api.createEndpoint({ id }),
      onSuccess: refreshEndpoints,
      onError: alertError,
    }),
    remove: useMutation({
      mutationFn: () => api.deleteEndpoint(endpointId),
      onSuccess: () => {
        qc.removeQueries({ queryKey: keys.requests(endpointId) });
        return refreshEndpoints();
      },
      onError: alertError,
    }),
    update: useMutation({
      mutationFn: (patch: Parameters<typeof api.updateEndpoint>[1]) => api.updateEndpoint(endpointId, patch),
      onSuccess: (saved) => qc.setQueryData<Endpoint[]>(keys.endpoints, (cur) => cur?.map((e) => (e.id === saved.id ? saved : e))),
    }),
    importFile: useMutation({
      mutationFn: async (file: File) => api.importRequests(endpointId, await file.text()),
      onSuccess: async ({ imported }) => {
        await Promise.all([refreshRequests(), refreshEndpoints()]);
        alert(`Imported ${imported} request${imported === 1 ? "" : "s"}.`);
      },
      onError: alertError,
    }),
    clear: useMutation({
      mutationFn: () => api.clearRequests(endpointId),
      onSuccess: refreshRequests,
      onError: alertError,
    }),
  };
}

/** The Sender history, the saved requests and the variables. */
export function useSenderData() {
  const sent = useQuery({ queryKey: keys.sent, queryFn: api.listSent });
  const saved = useQuery({ queryKey: keys.saved, queryFn: api.listSaved });
  const variables = useQuery({ queryKey: keys.variables, queryFn: api.getVariables });
  return { history: sent.data ?? [], saved: saved.data ?? [], variables: variables.data ?? [] };
}

/** A captured request, with headers and body. */
export const fetchRequest = (qc: QueryClient, id: string) =>
  qc.fetchQuery({ queryKey: keys.request(id), queryFn: () => api.getRequest(id) });

export function useSenderMutations() {
  const qc = useQueryClient();
  const refreshSaved = () => qc.invalidateQueries({ queryKey: keys.saved });
  return {
    send: useMutation({
      mutationFn: api.send,
      onSuccess: () => qc.invalidateQueries({ queryKey: keys.sent }),
    }),
    clearHistory: useMutation({
      mutationFn: api.clearSent,
      onSuccess: () => qc.setQueryData(keys.sent, []),
      onError: alertError,
    }),
    createSaved: useMutation({ mutationFn: api.createSaved, onSuccess: refreshSaved }),
    updateSaved: useMutation({
      mutationFn: ({ id, ...patch }: Parameters<typeof api.updateSaved>[1] & { id: string }) => api.updateSaved(id, patch),
      onSuccess: refreshSaved,
    }),
    deleteSaved: useMutation({
      mutationFn: (s: SavedRequest) => api.deleteSaved(s.id),
      onSuccess: refreshSaved,
      onError: alertError,
    }),
    setVariables: useMutation({
      mutationFn: api.setVariables,
      onSuccess: (v: HeaderPair[]) => qc.setQueryData(keys.variables, v),
    }),
  };
}

/** Gives the value after it has not changed for `ms` milliseconds. */
export function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function alertError(e: unknown) {
  alert(e instanceof Error ? e.message : String(e));
}
