import { describe, expect, it } from "vitest";
import { requestApproval } from "./approvalDialog.js";

describe("requestApproval", () => {
  it("resolves to no_display on an unsupported platform without spawning anything", async () => {
    const outcome = await requestApproval(
      { category: "shell_exec", subject: "ls", reason: "test" },
      "linux" as NodeJS.Platform,
    );
    expect(outcome).toEqual({ approved: false, reason: "no_display" });
  });
});
