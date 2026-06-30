// 메타데이터 도메인 타입 (항상 Postgres, ADR-003). 설계 §4.2.

export type Role = "member" | "admin";
export type CollectionMethod = "otel" | "logfile";

export interface User {
  id: string;
  email: string;
  name: string | null;
  departmentId: string | null;
  role: Role;
  createdAt: Date;
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
}

export interface Provider {
  /** 'claude_code' | 'codex' */
  key: string;
  displayName: string;
  /** OTLP service.name → provider 식별 (예: ['codex','codex_cli_rs']) */
  serviceNamePatterns: string[];
  collectionMethod: CollectionMethod;
  enabled: boolean;
}

export interface IngestToken {
  id: string;
  userId: string;
  /** sha256(평문) — 평문은 발급 시 1회만 노출 */
  tokenHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}
