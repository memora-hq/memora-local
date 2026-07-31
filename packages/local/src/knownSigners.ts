import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A device key Memora has verified a receipt from before.
 *
 * This is *continuity*, not identity: it proves a later bundle was signed by the same key as an
 * earlier one. It says nothing about who holds that key, and no UI built on it may imply otherwise.
 */
export interface KnownSigner {
  address: string;
  /** Whatever the person chose to call this device. Absent until they name it. */
  label?: string;
  first_seen: string;
  last_seen: string;
  receipts_verified: number;
}

interface KnownSignerFile {
  format: "memora.local.known-signers";
  version: 1;
  signers: KnownSigner[];
}

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

function empty(): KnownSignerFile {
  return { format: "memora.local.known-signers", version: 1, signers: [] };
}

/**
 * File-backed, deliberately tiny. Lives beside the evidence store rather than in the desktop's
 * settings file so the CLI can read the same trust list.
 */
export class KnownSignerStore {
  constructor(private readonly path: string) {}

  static forDataRoot(dataRoot: string): KnownSignerStore {
    return new KnownSignerStore(join(dataRoot, "known-signers.json"));
  }

  private async read(): Promise<KnownSignerFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<KnownSignerFile>;
      if (!Array.isArray(parsed.signers)) return empty();
      return { ...empty(), signers: parsed.signers.filter((signer) => typeof signer?.address === "string") };
    } catch {
      // Missing or unreadable: an absent trust list is simply an empty one.
      return empty();
    }
  }

  private async write(file: KnownSignerFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, this.path);
  }

  async list(): Promise<KnownSigner[]> {
    const { signers } = await this.read();
    return [...signers].sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  }

  async get(address: string): Promise<KnownSigner | undefined> {
    const target = normalize(address);
    return (await this.read()).signers.find((signer) => normalize(signer.address) === target);
  }

  /** Call only after a bundle from this key has actually verified. */
  async record(address: string, at = new Date().toISOString()): Promise<KnownSigner> {
    const file = await this.read();
    const target = normalize(address);
    const existing = file.signers.find((signer) => normalize(signer.address) === target);
    const signer: KnownSigner = existing
      ? { ...existing, last_seen: at, receipts_verified: existing.receipts_verified + 1 }
      : { address, first_seen: at, last_seen: at, receipts_verified: 1 };
    await this.write({ ...file, signers: [...file.signers.filter((entry) => normalize(entry.address) !== target), signer] });
    return signer;
  }

  /** Naming a device is the person's own note to self. An empty label clears it. */
  async label(address: string, label: string): Promise<KnownSigner | undefined> {
    const file = await this.read();
    const target = normalize(address);
    const existing = file.signers.find((signer) => normalize(signer.address) === target);
    if (!existing) return undefined;
    const trimmed = label.trim().slice(0, 60);
    const signer: KnownSigner = { ...existing };
    if (trimmed) signer.label = trimmed;
    else delete signer.label;
    await this.write({ ...file, signers: [...file.signers.filter((entry) => normalize(entry.address) !== target), signer] });
    return signer;
  }

  async forget(address: string): Promise<void> {
    const file = await this.read();
    const target = normalize(address);
    await this.write({ ...file, signers: file.signers.filter((signer) => normalize(signer.address) !== target) });
  }
}
