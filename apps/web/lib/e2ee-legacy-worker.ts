import { decryptE2eeRecord, encryptE2eeRecord } from "./e2ee-browser-crypto";
import type { LegacyMigrationSource } from "./e2ee-legacy-contract";

type FetchJson = (url: string, init?: RequestInit) => Promise<unknown>;

export type LegacyWorkerInput = {
  deviceId: string;
  contentOwnerId: string;
  contentKeyVersion: number;
  uck: Uint8Array;
  signal?: AbortSignal;
  fetchJson: FetchJson;
};

export async function runLegacyMigrationBatch(input: LegacyWorkerInput): Promise<{
  migrated: number;
  alreadyMigrated: number;
  complete: boolean;
}> {
  const page = await input.fetchJson("/api/content/legacy-migration/page?limit=25", {
    headers: { "X-Toard-Content-Device-Id": input.deviceId },
    signal: input.signal,
  }) as { records: LegacyMigrationSource[] };
  if (page.records.length === 0) return { migrated: 0, alreadyMigrated: 0, complete: true };
  const items = [];
  for (const source of page.records) {
    const record = await encryptE2eeRecord(
      input.uck,
      source,
      input.contentOwnerId,
      input.contentKeyVersion,
    );
    const roundTrip = await decryptE2eeRecord(input.uck, record);
    if (!equal(roundTrip, new TextEncoder().encode(source.text))) {
      throw new Error("LEGACY_ROUND_TRIP_FAILED");
    }
    items.push({ id: source.id, sourceDigest: source.sourceDigest, record });
  }
  const result = await input.fetchJson("/api/content/legacy-migration/commit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Toard-Content-Device-Id": input.deviceId,
    },
    body: JSON.stringify({ items }),
    signal: input.signal,
  }) as { migrated: number; alreadyMigrated: number };
  return { ...result, complete: false };
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
