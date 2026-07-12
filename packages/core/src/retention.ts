/** API가 늦은 사용 이벤트를 canonical 보정 대상으로 수락하는 논리 기간. */
export const USAGE_EVENT_LOGICAL_RETENTION_DAYS = 90;

/** outbox flush와 비동기 compactor가 90일 경계 이벤트를 처리할 물리 보존 여유. */
export const CLICKHOUSE_RAW_RETENTION_SAFETY_DAYS = 7;

/** ClickHouse raw와 delivered outbox canonical 근거의 실제 보존 기간. */
export const CLICKHOUSE_RAW_RETENTION_DAYS =
  USAGE_EVENT_LOGICAL_RETENTION_DAYS + CLICKHOUSE_RAW_RETENTION_SAFETY_DAYS;
