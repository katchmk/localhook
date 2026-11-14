import type { CapturedRequestSummary } from "./types";

type Listener = (req: CapturedRequestSummary) => void;

/** In-memory fan-out of new captured requests to SSE subscribers, keyed by endpoint id. */
export function createHub() {
  const listeners = new Map<string, Set<Listener>>();

  return {
    subscribe(endpointId: string, fn: Listener) {
      let set = listeners.get(endpointId);
      if (!set) listeners.set(endpointId, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(endpointId);
      };
    },
    publish(req: CapturedRequestSummary) {
      listeners.get(req.endpointId)?.forEach((fn) => fn(req));
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
