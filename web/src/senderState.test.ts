import { describe, expect, test } from "bun:test";
import type { SavedRequest } from "./api";
import { initialDraft } from "./senderDraft";
import { initialSenderState, senderReducer } from "./senderState";

const saved = { id: "s1", collection: "Default", name: "Ping", request: { method: "GET", url: "http://x" } } as SavedRequest;

describe("senderReducer", () => {
  test("the default URL does not replace a URL the user typed", () => {
    const typed = senderReducer(initialSenderState(), { type: "draftUpdated", update: (d) => ({ ...d, url: "http://mine" }) });
    expect(senderReducer(typed, { type: "defaultUrlFound", url: "http://default" }).draft.url).toBe("http://mine");
    expect(senderReducer(initialSenderState(), { type: "defaultUrlFound", url: "http://default" }).draft.url).toBe(
      "http://default",
    );
  });

  test("an unsaved load stops editing the saved request and clears the error", () => {
    let s = senderReducer(initialSenderState(), { type: "savedStored", saved });
    s = senderReducer(s, { type: "failed", error: "boom" });
    s = senderReducer(s, { type: "curlImported", draft: initialDraft() });
    expect(s.current).toBeNull();
    expect(s.error).toBeNull();
    expect(s.showImport).toBe(false);
  });

  test("deleting another saved request keeps the current one", () => {
    const s = senderReducer(initialSenderState(), { type: "savedStored", saved });
    expect(senderReducer(s, { type: "savedDeleted", id: "other" })).toBe(s);
    expect(senderReducer(s, { type: "savedDeleted", id: "s1" }).current).toBeNull();
  });
});
