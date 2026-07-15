import { decryptE2eeRecord, encryptE2eeRecord } from "./e2ee-browser-crypto";
import {
  LEGACY_MIGRATION_MAX_BATCH_SIZE,
  LEGACY_MIGRATION_MAX_PAYLOAD_BYTES,
  type LegacyMigrationSource,
} from "./e2ee-legacy-contract";

export { LEGACY_MIGRATION_MAX_PAYLOAD_BYTES } from "./e2ee-legacy-contract";

export const LEGACY_MIGRATION_INITIAL_BATCH_SIZE = 25;
const FAST_BATCH_MS = 300;
const SLOW_BATCH_MS = 1_000;
const SMALL_PAYLOAD_BYTES = 1024 * 1024;
const LARGE_PAYLOAD_BYTES = 3 * 1024 * 1024;

type FetchJson = (url: string, init?: RequestInit) => Promise<unknown>;

export type LegacyWorkerInput = {
  deviceId: string;
  contentOwnerId: string;
  contentKeyVersion: number;
  batchLimit?: number;
  uck: Uint8Array;
  signal?: AbortSignal;
  fetchJson: FetchJson;
};

export async function runLegacyMigrationBatch(input: LegacyWorkerInput): Promise<{
  migrated: number;
  alreadyMigrated: number;
  complete: boolean;
  payloadBytes: number;
}> {
  const batchLimit = clampBatchLimit(input.batchLimit ?? LEGACY_MIGRATION_INITIAL_BATCH_SIZE);
  const page = await input.fetchJson(`/api/content/legacy-migration/page?limit=${batchLimit}`, {
    headers: { "X-Toard-Content-Device-Id": input.deviceId },
    signal: input.signal,
  }) as { records: LegacyMigrationSource[] };
  if (page.records.length === 0) {
    return { migrated: 0, alreadyMigrated: 0, complete: true, payloadBytes: 0 };
  }
  const items = [];
  const serializedItems: string[] = [];
  const encoder = new TextEncoder();
  let payloadBytes = encoder.encode('{"items":[]}').byteLength;
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
    const item = { id: source.id, sourceDigest: source.sourceDigest, record };
    const serialized = JSON.stringify(item);
    const itemBytes = encoder.encode(serialized).byteLength;
    const separatorBytes = items.length === 0 ? 0 : 1;
    if (payloadBytes + separatorBytes + itemBytes > LEGACY_MIGRATION_MAX_PAYLOAD_BYTES) {
      if (items.length === 0) throw new Error("LEGACY_MIGRATION_ITEM_TOO_LARGE");
      break;
    }
    items.push(item);
    serializedItems.push(serialized);
    payloadBytes += separatorBytes + itemBytes;
  }
  const body = `{"items":[${serializedItems.join(",")}]}`;
  const result = await input.fetchJson("/api/content/legacy-migration/commit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Toard-Content-Device-Id": input.deviceId,
    },
    body,
    signal: input.signal,
  }) as { migrated: number; alreadyMigrated: number };
  return { ...result, complete: false, payloadBytes };
}

export function nextLegacyMigrationBatchLimit(
  current: number,
  elapsedMs: number,
  payloadBytes: number,
): number {
  const bounded = clampBatchLimit(current);
  if (elapsedMs > SLOW_BATCH_MS || payloadBytes > LARGE_PAYLOAD_BYTES) {
    return Math.max(LEGACY_MIGRATION_INITIAL_BATCH_SIZE, Math.floor(bounded / 2));
  }
  if (elapsedMs < FAST_BATCH_MS && payloadBytes < SMALL_PAYLOAD_BYTES) {
    return Math.min(LEGACY_MIGRATION_MAX_BATCH_SIZE, bounded * 2);
  }
  return bounded;
}

function clampBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value)) return LEGACY_MIGRATION_INITIAL_BATCH_SIZE;
  return Math.min(LEGACY_MIGRATION_MAX_BATCH_SIZE, Math.max(1, value));
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
