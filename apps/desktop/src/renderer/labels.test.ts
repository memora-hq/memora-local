import type { LocalVerificationResult } from "@smritheon/memora-local";
import { describe, expect, it } from "vitest";
import {
  assuranceLabels,
  disclosureLabel,
  disclosureStatement,
  EVIDENCE_FIELDS,
  fieldLabel,
  levelAtLeast,
  READING_LEVELS,
  showsField,
  showsRawEvidence,
  showsTimelineByDefault,
  signerStatement,
  traceCountLabels,
  traceFilterLabels,
  type EvidenceFieldId,
  type ReadingLevel,
  type SignerIdentity,
} from "./labels";
import type { TraceViewModel } from "./viewModels";

const verification: LocalVerificationResult = {
  valid: true,
  integrity: "verified",
  identity: "self-issued-continuity-verified",
  completeness: "complete",
  anchoring: "local-only",
  checks: [],
};

const CRYPTO_FIELDS: EvidenceFieldId[] = ["payload_hash", "cid_ciphertext", "signer", "signature"];

describe("levelAtLeast", () => {
  it("orders the levels from plain language to developer", () => {
    const expected: Record<ReadingLevel, ReadingLevel[]> = {
      everyone: ["everyone"],
      power: ["everyone", "power"],
      developer: ["everyone", "power", "developer"],
    };
    for (const current of READING_LEVELS) {
      for (const minimum of READING_LEVELS) {
        expect(levelAtLeast(current, minimum)).toBe(expected[current].includes(minimum));
      }
    }
  });

  it("reserves raw evidence and the default timeline for the right levels", () => {
    expect(READING_LEVELS.filter(showsRawEvidence)).toEqual(["developer"]);
    expect(READING_LEVELS.filter(showsTimelineByDefault)).toEqual(["power", "developer"]);
  });
});

describe("evidence field gating", () => {
  it("keeps every cryptographic field out of reach below developer", () => {
    for (const id of CRYPTO_FIELDS) {
      expect(showsField(id, "everyone")).toBe(false);
      expect(showsField(id, "power")).toBe(false);
      expect(showsField(id, "developer")).toBe(true);
    }
  });

  it("shows no field with a cryptographic label to a plain-language reader", () => {
    const visible = (Object.keys(EVIDENCE_FIELDS) as EvidenceFieldId[]).filter((id) => showsField(id, "everyone"));
    expect(visible.length).toBeGreaterThan(0);
    for (const id of visible) {
      expect(fieldLabel(id, "everyone")).not.toMatch(/hash|cid|signature|ciphertext|signer/i);
    }
  });

  it("uses plain labels below developer and the raw field name at developer", () => {
    expect(fieldLabel("event_type", "everyone")).toBe("What happened");
    expect(fieldLabel("event_type", "developer")).toBe("Event type");
    expect(fieldLabel("payload_hash", "developer")).toBe("payload_hash");
    expect(fieldLabel("cid_ciphertext", "developer")).toBe("cid_ciphertext");
  });
});

describe("disclosureLabel", () => {
  it("hides the integrity disclosure entirely below developer", () => {
    expect(disclosureLabel("integrity", "everyone")).toBeUndefined();
    expect(disclosureLabel("integrity", "power")).toBeUndefined();
    expect(disclosureLabel("integrity", "developer")).toEqual({ title: "Integrity evidence", hint: "Hashes, signer, and ciphertext" });
  });

  it("hides lineage and verification from a plain-language reader", () => {
    expect(disclosureLabel("lineage", "everyone")).toBeUndefined();
    expect(disclosureLabel("verification", "everyone")).toBeUndefined();
    expect(disclosureLabel("lineage", "power")).toBeDefined();
    expect(disclosureLabel("verification", "power")).toBeDefined();
  });

  it("rewrites the receipt disclosure in plain language", () => {
    expect(disclosureLabel("receipt", "everyone")).toEqual({ title: "What this action was", hint: "When Memora saw it, and how" });
    expect(disclosureLabel("receipt", "developer")?.title).toBe("Receipt metadata");
  });
});

describe("assuranceLabels", () => {
  it("states the four signals without protocol vocabulary below developer", () => {
    for (const level of ["everyone", "power"] as const) {
      const labels = assuranceLabels(verification, level);
      // Only `label` and `value` are rendered; `id` is a programmatic key.
      const rendered = labels.map((entry) => `${entry.label} ${entry.value}`).join(" ");
      expect(rendered).not.toMatch(/local-only|self-issued|anchor|continuity/i);
      expect(labels.map((entry) => entry.value)).toEqual([
        "Unchanged since recording",
        "Same identity throughout",
        "Full session",
        "Sealed on this device",
      ]);
    }
  });

  it("keeps the raw vocabulary at developer level", () => {
    const rendered = assuranceLabels(verification, "developer").map((entry) => `${entry.label} ${entry.value}`).join(" ");
    expect(rendered).toMatch(/anchor/i);
    expect(rendered).toMatch(/continuity/i);
  });

  it("reports failures and gaps plainly", () => {
    const failed = assuranceLabels({ ...verification, integrity: "failed", identity: "failed", completeness: "interrupted" }, "everyone");
    expect(failed.map((entry) => entry.value)).toEqual([
      "Changed after recording",
      "Identity does not match",
      "Cut short",
      "Sealed on this device",
    ]);
  });

  it("returns nothing while verification is still running", () => {
    expect(assuranceLabels(undefined, "everyone")).toEqual([]);
  });
});

describe("signerStatement", () => {
  const stranger: SignerIdentity = { address: "0xAb12Cd34Ef56Ab78Cd90Ef12Ab34Cd56Ef78Ab90", isThisDevice: false, known: false };

  it("never lets a signature imply who produced the record", () => {
    const claims: SignerIdentity[] = [
      stranger,
      { ...stranger, known: true, receiptsVerified: 4, firstSeen: "2026-06-12T10:00:00.000Z" },
      { ...stranger, known: true, label: "Priya's laptop", receiptsVerified: 4 },
    ];
    for (const signer of claims) {
      for (const level of READING_LEVELS) {
        const statement = signerStatement(signer, level);
        expect(statement.lines.join(" ")).toContain("does not prove who produced it");
        expect(statement.canName).toBe(true);
      }
    }
  });

  it("truncates the key below developer and shows it whole at developer", () => {
    expect(signerStatement(stranger, "everyone").address).not.toBe(stranger.address);
    expect(signerStatement(stranger, "everyone").address).toContain("…");
    expect(signerStatement(stranger, "developer").address).toBe(stranger.address);
  });

  it("distinguishes a first sighting, a repeat device, and a named one", () => {
    expect(signerStatement(stranger, "everyone").title).toBe("A device Memora has not seen before");
    expect(signerStatement({ ...stranger, known: true, receiptsVerified: 4 }, "everyone").title)
      .toBe("A device you have verified before");
    expect(signerStatement({ ...stranger, known: true, label: "Priya's laptop" }, "everyone").title)
      .toBe("Same device as “Priya's laptop”");
  });

  it("marks your own device as yours and offers no naming", () => {
    const own = signerStatement({ ...stranger, isThisDevice: true, known: true }, "everyone");
    expect(own.title).toBe("Signed by this device");
    expect(own.canName).toBe(false);
  });
});

describe("disclosureStatement", () => {
  it("says plainly how much of the record can actually be read", () => {
    expect(disclosureStatement("none", 0, 12).title).toBe("Sealed");
    expect(disclosureStatement("none", 0, 12).detail).toContain("proof without content");
    expect(disclosureStatement("partial", 3, 12).detail).toContain("3 of 12 records");
    expect(disclosureStatement("full", 12, 12).detail).toContain("All 12 records");
  });

  it("ties readable content back to the signature that covers it", () => {
    expect(disclosureStatement("full", 12, 12).detail).toMatch(/matches the signature/);
    expect(disclosureStatement("partial", 3, 12).detail).toMatch(/matched to their signatures/);
  });
});

describe("trace labels", () => {
  const trace: TraceViewModel = {
    turns: [],
    totalEvents: 12,
    visibleActions: 5,
    toolCalls: 1,
    fileChanges: 3,
    promptCount: 2,
  };

  it("drops the encrypted-record aside for a plain-language reader", () => {
    expect(traceCountLabels(trace, "everyone")).toEqual({
      heading: "5 actions",
      aside: "",
      detail: "2 requests · 1 tool call · 3 file changes",
    });
    expect(traceCountLabels(trace, "power").aside).toBe("from 12 encrypted records");
  });

  it("renames the filters without changing their ids", () => {
    const plain = traceFilterLabels("everyone");
    const power = traceFilterLabels("power");
    expect(plain.map(([id]) => id)).toEqual(power.map(([id]) => id));
    expect(plain.map(([, label]) => label)).not.toEqual(power.map(([, label]) => label));
    expect(plain[0]).toEqual(["all", "Everything"]);
  });
});
