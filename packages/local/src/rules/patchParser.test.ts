import { describe, expect, it } from "vitest";
import { parsePatchFilePaths } from "./patchParser.js";

describe("parsePatchFilePaths", () => {
  it("extracts a single added file", () => {
    const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+content\n*** End Patch";
    expect(parsePatchFilePaths(patch)).toEqual(["src/new.ts"]);
  });

  it("extracts multiple files across add/update/delete", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+content",
      "*** Update File: src/existing.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n");
    expect(parsePatchFilePaths(patch)).toEqual(["src/new.ts", "src/existing.ts", "src/old.ts"]);
  });

  it("includes a Move to target alongside the Update File source", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "@@",
      "*** End Patch",
    ].join("\n");
    expect(parsePatchFilePaths(patch)).toEqual(["src/old-name.ts", "src/new-name.ts"]);
  });

  it("trims trailing whitespace from extracted paths", () => {
    const patch = "*** Add File: src/new.ts   \n+content";
    expect(parsePatchFilePaths(patch)).toEqual(["src/new.ts"]);
  });

  it("returns an empty array when no file lines are present", () => {
    expect(parsePatchFilePaths("*** Begin Patch\n*** End Patch")).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parsePatchFilePaths("")).toEqual([]);
  });
});
