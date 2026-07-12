import type { FinalizedUsageEvent, StorageBackend, UsageEvent } from "@toard/core";

function verifyFinalizedStorageContract(
  storage: StorageBackend,
  finalizedEvents: FinalizedUsageEvent[],
  rawEvents: UsageEvent[],
): void {
  void storage.saveUsageEvents(finalizedEvents);

  // @ts-expect-error 가격 revision과 상태가 없는 raw 이벤트는 저장 계약을 통과할 수 없다.
  void storage.saveUsageEvents(rawEvents);
}

void verifyFinalizedStorageContract;
