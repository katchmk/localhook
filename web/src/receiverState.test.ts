import { describe, expect, test } from "bun:test";
import { initialReceiverState, receiverReducer, visibleSelection, type ReceiverAction } from "./receiverState";

const run = (...actions: ReceiverAction[]) => actions.reduce(receiverReducer, initialReceiverState);

describe("receiverReducer", () => {
  test("a row click selects the request when compare mode is off", () => {
    expect(run({ type: "rowClicked", id: "a" }).selectedId).toBe("a");
  });

  test("compare keeps only the two last picks and a second click removes a pick", () => {
    const s = run(
      { type: "compareToggled" },
      { type: "rowClicked", id: "a" },
      { type: "rowClicked", id: "b" },
      { type: "rowClicked", id: "c" },
    );
    expect(s.compare).toEqual(["b", "c"]);
    expect(s.selectedId).toBeNull();
    expect(receiverReducer(s, { type: "rowClicked", id: "b" }).compare).toEqual(["c"]);
    expect(receiverReducer(s, { type: "compareToggled" }).compare).toBeNull();
  });

  test("settingsClosed keeps the same state object when settings are closed", () => {
    expect(receiverReducer(initialReceiverState, { type: "settingsClosed" })).toBe(initialReceiverState);
    expect(run({ type: "settingsToggled" }, { type: "settingsClosed" }).showSettings).toBe(false);
  });
});

describe("visibleSelection", () => {
  test("falls back to the first request when the pick is not in the list", () => {
    expect(visibleSelection("x", ["a", "b"])).toBe("a");
    expect(visibleSelection("b", ["a", "b"])).toBe("b");
    expect(visibleSelection(null, [])).toBeNull();
  });
});
