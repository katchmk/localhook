import type { SavedRequest, SentRequest } from "./api";
import { draftFromSaved, draftFromSent, initialDraft, type Draft } from "./senderDraft";

export type EditorTab = "body" | "auth" | "signature" | "headers" | "cookies";

/** The editor state of the Sender. Server data lives in the query cache, not here. */
export type SenderState = {
  draft: Draft;
  /** The saved request in the editor, which Save updates. Null for a new request. */
  current: SavedRequest | null;
  response: SentRequest | null;
  error: string | null;
  tab: EditorTab;
  showImport: boolean;
};

export type SenderAction =
  | { type: "draftUpdated"; update: (d: Draft) => Draft }
  /** Loads a request that is not a saved one, so Save makes a new saved request. */
  | { type: "unsavedLoaded"; draft: Draft }
  | { type: "curlImported"; draft: Draft }
  | { type: "sentLoaded"; sent: SentRequest }
  | { type: "savedLoaded"; saved: SavedRequest }
  /** Sets the target only when the user has not typed one. */
  | { type: "defaultUrlFound"; url: string }
  | { type: "savedStored"; saved: SavedRequest }
  | { type: "savedDeleted"; id: string }
  | { type: "currentCleared" }
  | { type: "sendStarted" }
  | { type: "responseReceived"; response: SentRequest }
  | { type: "failed"; error: string }
  | { type: "tabChanged"; tab: EditorTab }
  | { type: "importToggled" };

export const initialSenderState = (): SenderState => ({
  draft: initialDraft(),
  current: null,
  response: null,
  error: null,
  tab: "body",
  showImport: false,
});

export function senderReducer(state: SenderState, action: SenderAction): SenderState {
  switch (action.type) {
    case "draftUpdated":
      return { ...state, draft: action.update(state.draft) };
    case "unsavedLoaded":
      return { ...state, draft: action.draft, current: null, error: null };
    case "curlImported":
      return { ...state, draft: action.draft, current: null, error: null, showImport: false };
    case "sentLoaded":
      return { ...state, draft: draftFromSent(action.sent), current: null, error: null, response: action.sent };
    case "savedLoaded":
      return { ...state, draft: draftFromSaved(action.saved.request), current: action.saved, error: null };
    case "defaultUrlFound":
      return state.draft.url ? state : { ...state, draft: { ...state.draft, url: action.url } };
    case "savedStored":
      return { ...state, current: action.saved, error: null };
    case "savedDeleted":
      return state.current?.id === action.id ? { ...state, current: null } : state;
    case "currentCleared":
      return { ...state, current: null };
    case "sendStarted":
      return { ...state, error: null };
    case "responseReceived":
      return { ...state, response: action.response };
    case "failed":
      return { ...state, error: action.error };
    case "tabChanged":
      return { ...state, tab: action.tab };
    case "importToggled":
      return { ...state, showImport: !state.showImport };
  }
}
