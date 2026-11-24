/** The UI state of one endpoint in the Receiver. Server data lives in the query cache, not here. */
export type ReceiverState = {
  /** The request the user picked; null shows the first request in the list. */
  selectedId: string | null;
  showSettings: boolean;
  showDomain: boolean;
  /** The search text as typed. The list uses it after a short pause in typing. */
  search: string;
  method: string;
  /** Ids picked for compare; null when compare mode is off. */
  compare: string[] | null;
};

export type ReceiverAction =
  | { type: "rowClicked"; id: string }
  /** Holds the request that is on screen, so a new request at the top of the list does not replace it. */
  | { type: "selectionPinned"; id: string | null }
  | { type: "settingsToggled" }
  | { type: "settingsClosed" }
  | { type: "domainToggled" }
  | { type: "searchChanged"; search: string }
  | { type: "methodChanged"; method: string }
  | { type: "compareToggled" }
  | { type: "compareClosed" };

export const initialReceiverState: ReceiverState = {
  selectedId: null,
  showSettings: false,
  showDomain: false,
  search: "",
  method: "",
  compare: null,
};

export function receiverReducer(state: ReceiverState, action: ReceiverAction): ReceiverState {
  switch (action.type) {
    case "rowClicked": {
      const { compare } = state;
      if (!compare) return { ...state, selectedId: action.id };
      const next = compare.includes(action.id)
        ? compare.filter((c) => c !== action.id)
        : [...compare, action.id].slice(-2); // A third pick replaces the oldest pick.
      return { ...state, compare: next };
    }
    case "selectionPinned":
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
    case "settingsToggled":
      return { ...state, showSettings: !state.showSettings };
    case "settingsClosed":
      return state.showSettings ? { ...state, showSettings: false } : state;
    case "domainToggled":
      return { ...state, showDomain: !state.showDomain };
    case "searchChanged":
      return { ...state, search: action.search };
    case "methodChanged":
      return { ...state, method: action.method };
    case "compareToggled":
      return { ...state, compare: state.compare ? null : [] };
    case "compareClosed":
      return { ...state, compare: null };
  }
}

/** The request to show: the picked one while it is in the list, else the first one. */
export function visibleSelection(selectedId: string | null, ids: string[]): string | null {
  return selectedId && ids.includes(selectedId) ? selectedId : (ids[0] ?? null);
}
