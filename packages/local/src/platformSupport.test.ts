import { describe, expect, it } from "vitest";
import { isSupportedPlatform, unsupportedPlatformMessage } from "./platformSupport.js";

describe("isSupportedPlatform", () => {
  it("supports macOS and Windows", () => {
    expect(isSupportedPlatform("darwin")).toBe(true);
    expect(isSupportedPlatform("win32")).toBe(true);
  });

  it("does not support Linux", () => {
    expect(isSupportedPlatform("linux")).toBe(false);
  });

  it("does not support other platforms", () => {
    expect(isSupportedPlatform("freebsd")).toBe(false);
    expect(isSupportedPlatform("aix")).toBe(false);
  });

  it("defaults to the current process platform", () => {
    expect(isSupportedPlatform()).toBe(isSupportedPlatform(process.platform));
  });
});

describe("unsupportedPlatformMessage", () => {
  it("names the detected platform and points at the tracking issue", () => {
    const message = unsupportedPlatformMessage("linux");
    expect(message).toContain("linux");
    expect(message).toContain("macOS");
    expect(message).toContain("Windows");
    expect(message).toContain("github.com/memora-hq/memora-local/issues/12");
  });

  it("contains no node-gyp or compiler language", () => {
    const message = unsupportedPlatformMessage("linux");
    expect(message.toLowerCase()).not.toContain("node-gyp");
    expect(message.toLowerCase()).not.toContain("gcc");
    expect(message).not.toContain("Error:");
  });
});
