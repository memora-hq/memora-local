import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { KnownSignerStore } from "./knownSigners.js";

const ADDRESS = "0xAb12Cd34Ef56Ab78Cd90Ef12Ab34Cd56Ef78Ab90";

let store: KnownSignerStore;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memora-signers-"));
  store = KnownSignerStore.forDataRoot(root);
});

describe("known signers", () => {
  it("starts empty and counts each verified receipt", async () => {
    expect(await store.list()).toEqual([]);

    const first = await store.record(ADDRESS, "2026-06-12T10:00:00.000Z");
    expect(first.receipts_verified).toBe(1);
    expect(first.first_seen).toBe("2026-06-12T10:00:00.000Z");
    expect(first.label).toBeUndefined();

    const second = await store.record(ADDRESS, "2026-07-26T10:00:00.000Z");
    expect(second.receipts_verified).toBe(2);
    expect(second.first_seen).toBe("2026-06-12T10:00:00.000Z");
    expect(second.last_seen).toBe("2026-07-26T10:00:00.000Z");
    expect(await store.list()).toHaveLength(1);
  });

  it("matches a signer regardless of address casing", async () => {
    await store.record(ADDRESS);
    expect(await store.get(ADDRESS.toLowerCase())).toBeDefined();
    await store.record(ADDRESS.toLowerCase());
    expect(await store.list()).toHaveLength(1);
  });

  it("names, renames, and clears a label without losing the count", async () => {
    await store.record(ADDRESS);
    await store.record(ADDRESS);

    expect((await store.label(ADDRESS, "  Priya's laptop  "))?.label).toBe("Priya's laptop");
    expect((await store.label(ADDRESS, "Build machine"))?.label).toBe("Build machine");

    const cleared = await store.label(ADDRESS, "   ");
    expect(cleared?.label).toBeUndefined();
    expect(cleared?.receipts_verified).toBe(2);
  });

  it("will not name a device it has never verified", async () => {
    expect(await store.label(ADDRESS, "Nice try")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("forgets a device completely", async () => {
    await store.record(ADDRESS);
    await store.forget(ADDRESS);
    expect(await store.get(ADDRESS)).toBeUndefined();

    const reappeared = await store.record(ADDRESS);
    expect(reappeared.receipts_verified).toBe(1);
  });

  it("survives an unreadable trust list instead of failing a verification", async () => {
    await writeFile(join(root, "known-signers.json"), "{ not json");
    expect(await store.list()).toEqual([]);
    expect((await store.record(ADDRESS)).receipts_verified).toBe(1);
    expect(JSON.parse(await readFile(join(root, "known-signers.json"), "utf8")).signers).toHaveLength(1);
  });

  it("lists the most recently seen device first", async () => {
    const other = "0x1111111111111111111111111111111111111111";
    await store.record(ADDRESS, "2026-06-12T10:00:00.000Z");
    await store.record(other, "2026-07-26T10:00:00.000Z");
    expect((await store.list()).map((signer) => signer.address)).toEqual([other, ADDRESS]);
  });
});
