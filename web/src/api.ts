import type {
  CapturedRequest,
  CapturedRequestSummary,
  Endpoint,
  SendInput,
  SentRequest,
} from "../../server/types";

export type * from "../../server/types";

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
  listEndpoints: () => call<Endpoint[]>("/endpoints"),
  createEndpoint: (input: { id?: string; name?: string } = {}) =>
    call<Endpoint>("/endpoints", { method: "POST", body: JSON.stringify(input) }),
  updateEndpoint: (id: string, patch: Partial<Endpoint>) =>
    call<Endpoint>(`/endpoints/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteEndpoint: (id: string) => call<void>(`/endpoints/${id}`, { method: "DELETE" }),

  listRequests: (endpointId: string) => call<CapturedRequestSummary[]>(`/endpoints/${endpointId}/requests`),
  clearRequests: (endpointId: string) => call<void>(`/endpoints/${endpointId}/requests`, { method: "DELETE" }),
  getRequest: (id: string) => call<CapturedRequest>(`/requests/${id}`),
  deleteRequest: (id: string) => call<void>(`/requests/${id}`, { method: "DELETE" }),
  replay: (id: string, url: string) =>
    call<SentRequest>(`/requests/${id}/replay`, { method: "POST", body: JSON.stringify({ url }) }),

  send: (input: SendInput) => call<SentRequest>("/send", { method: "POST", body: JSON.stringify(input) }),
  listSent: () => call<SentRequest[]>("/sent"),
  clearSent: () => call<void>("/sent", { method: "DELETE" }),
};

export const hookUrl = (endpointId: string) => `${window.location.origin}/hook/${endpointId}`;
export const bodyUrl = (requestId: string) => `/api/requests/${requestId}/body`;
export const exportUrl = (endpointId: string) => `/api/endpoints/${endpointId}/export`;
export const streamUrl = (endpointId: string) => `/api/endpoints/${endpointId}/stream`;
