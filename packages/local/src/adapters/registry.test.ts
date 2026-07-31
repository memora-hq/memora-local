import { describe, expect, it } from "vitest";
import { adapters, getAdapter } from "./registry.js";

describe("adapter registry", () => {
  it("gives every adapter a non-empty id, displayName, attributionNote, and eventMap", () => {
    for (const adapter of adapters) {
      expect(adapter.id.length).toBeGreaterThan(0);
      expect(adapter.displayName.length).toBeGreaterThan(0);
      expect(adapter.attributionNote.length).toBeGreaterThan(0);
      expect(Object.keys(adapter.eventMap).length).toBeGreaterThan(0);
    }
  });

  it("returns the right entry for a known id", () => {
    const claude = getAdapter("claude");
    expect(claude?.displayName).toBe("Claude Code");
    expect(claude?.captureTier).toBe("deep");

    const cursor = getAdapter("cursor");
    expect(cursor?.displayName).toBe("Cursor");
    expect(cursor?.captureTier).toBe("partial");
  });

  it("returns undefined for an unknown id", () => {
    expect(getAdapter("nonexistent")).toBeUndefined();
  });
});
