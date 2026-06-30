import type { StorageBackend } from "@toard/core";
import { PostgresStorage } from "@toard/storage-postgres";
import { getPool } from "./db";

let storage: StorageBackend | undefined;

/** 저장 백엔드 싱글톤 (ADR-003: 기본 postgres, CH 모드는 storage-clickhouse 추가 시 분기) */
export function getStorage(): StorageBackend {
  if (!storage) {
    if (process.env.STORAGE_BACKEND === "clickhouse") {
      throw new Error("clickhouse backend not implemented yet (옵트인 — 2차)");
    }
    storage = new PostgresStorage(getPool());
  }
  return storage;
}
