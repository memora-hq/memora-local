import { describe, expect, it } from "vitest";
import { compactEmbeddedValues } from "./components";

describe("desktop detail presentation", () => {
  it("summarizes embedded binary results without changing ordinary tool output", () => {
    expect(compactEmbeddedValues({ exit_code: 0, output: "passed" })).toEqual({ exit_code: 0, output: "passed" });
    const compacted = compactEmbeddedValues({
      image_url: `data:image/png;base64,${"a".repeat(20_000)}`,
    }) as { image_url: string };
    expect(compacted.image_url).toContain("embedded image/png");
    expect(compacted.image_url).toContain("available in raw payload");
    expect(compacted.image_url).not.toContain("a".repeat(100));
  });
});
