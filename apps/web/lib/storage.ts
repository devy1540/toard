import type { StorageBackend } from "@toard/core";
import { createClickHouseStorage } from "@toard/storage-clickhouse";
import { PostgresStorage } from "@toard/storage-postgres";
import { getPool } from "./db";
import { getOrgTimezone } from "./org-time";

let storage: StorageBackend | undefined;

/** 저장 백엔드 싱글톤 (ADR-003: 기본 postgres, STORAGE_BACKEND=clickhouse 면 CH). 메타는 항상 PG. */
export function getStorage(): StorageBackend {
  if (!storage) {
    const timezone = getOrgTimezone();
    storage =
      process.env.STORAGE_BACKEND === "clickhouse"
        ? createClickHouseStorage(getPool(), { timezone })
        : new PostgresStorage(getPool(), { timezone });
  }
  return storage;
}

/** 일회성 CLI가 만든 ClickHouse client/timer를 명시적으로 정리한다. */
export async function closeStorage(): Promise<void> {
  const current = storage as (StorageBackend & { close?: () => Promise<void> }) | undefined;
  storage = undefined;
  if (current?.close) await current.close();
}
