import type {
  CapturedRequest,
  CapturedRequestSummary,
  Endpoint,
  HeaderPair,
  SavedRequest,
  SavedRequestData,
  SendInput,
  SentRequest,
  TunnelInfo,
} from "../../server/types";

export type * from "../../server/types";
export {
  DEFAULT_CUSTOM_SIGNATURE,
  DOMAIN_PROVIDER,
  FORWARD_MODES,
  SIGNATURE_ALGORITHMS,
  SIGNATURE_SCHEMES,
} from "../../server/types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  getTunnel: () => call<TunnelInfo>("/tunnel"),
  setTunnel: (provider: string) => call<TunnelInfo>("/tunnel", { method: "PUT", body: JSON.stringify({ provider }) }),
  /** An empty hostname removes the own-domain settings. Without a token, the saved token stays. */
  setTunnelDomain: (input: { hostname: string; token?: string }) =>
    call<TunnelInfo>("/tunnel/domain", { method: "PUT", body: JSON.stringify(input) }),
  listEndpoints: () => call<Endpoint[]>("/endpoints"),
  createEndpoint: (input: { id?: string; name?: string } = {}) =>
    call<Endpoint>("/endpoints", { method: "POST", body: JSON.stringify(input) }),
  updateEndpoint: (id: string, patch: Partial<Endpoint> & { signatureSecret?: string }) =>
    call<Endpoint>(`/endpoints/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteEndpoint: (id: string) => call<void>(`/endpoints/${id}`, { method: "DELETE" }),
  getSignatureSecret: (id: string) => call<{ signatureSecret: string }>(`/endpoints/${id}/secret`),

  listRequests: (endpointId: string, filter: { method?: string; q?: string } = {}) => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]);
    return call<CapturedRequestSummary[]>(`/endpoints/${endpointId}/requests${params.size ? `?${params}` : ""}`);
  },
  importRequests: (endpointId: string, fileText: string) =>
    call<{ imported: number }>(`/endpoints/${endpointId}/import`, { method: "POST", body: fileText }),
  clearRequests: (endpointId: string) => call<void>(`/endpoints/${endpointId}/requests`, { method: "DELETE" }),
  getRequest: (id: string) => call<CapturedRequest>(`/requests/${id}`),
  deleteRequest: (id: string) => call<void>(`/requests/${id}`, { method: "DELETE" }),
  replay: (id: string, url: string) =>
    call<SentRequest>(`/requests/${id}/replay`, { method: "POST", body: JSON.stringify({ url }) }),

  send: (input: SendInput) => call<SentRequest>("/send", { method: "POST", body: JSON.stringify(input) }),
  listSent: () => call<SentRequest[]>("/sent"),
  clearSent: () => call<void>("/sent", { method: "DELETE" }),

  listSaved: () => call<SavedRequest[]>("/saved"),
  createSaved: (input: { collection: string; name: string; request: SavedRequestData }) =>
    call<SavedRequest>("/saved", { method: "POST", body: JSON.stringify(input) }),
  updateSaved: (id: string, patch: { collection?: string; name?: string; request?: SavedRequestData }) =>
    call<SavedRequest>(`/saved/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteSaved: (id: string) => call<void>(`/saved/${id}`, { method: "DELETE" }),
  getVariables: () => call<HeaderPair[]>("/variables"),
  setVariables: (variables: HeaderPair[]) =>
    call<HeaderPair[]>("/variables", { method: "PUT", body: JSON.stringify(variables) }),
};

export const hookUrl = (endpointId: string) => `${window.location.origin}/hook/${endpointId}`;
export const bodyUrl = (requestId: string) => `/api/requests/${requestId}/body`;
export const exportUrl = (endpointId: string, format: "json" | "har" = "json") =>
  `/api/endpoints/${endpointId}/export${format === "har" ? "?format=har" : ""}`;
export const streamUrl = (endpointId: string) => `/api/endpoints/${endpointId}/stream`;
