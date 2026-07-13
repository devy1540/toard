# Rollup 공정 coordinator와 확정 구간 처리 설계

## 목적

15분 기준 rollup, 시간대별 1시간·1일 rollup, 자동 읽기 전환 검증이 같은 부하 슬롯을 사용하면서도 서로 굶기지 않도록 한다. 시간대별 rollup은 15분 기준이 확정된 구간만 처리해 중복 계산과 잘못된 중간 결과를 줄인다. 신규 수집과 사용자 조회는 백필과 분리하고, 준비되지 않은 구간은 기존의 정확한 대체 조회를 유지한다.

이 설계의 성공 기준은 다음과 같다.

- 처리 가능한 rollup 작업은 120초 이상 선택되지 않은 채 남지 않는다.
- 전체 앱 replica에서 무거운 ClickHouse rollup·검증 작업은 동시에 하나만 실행한다.
- 시간대별 hour/day 작업은 원천 15분 구간이 연속 완료되고 재계산 필요 상태가 없을 때만 처리한다.
- 처리 중 늦은 데이터가 들어오면 계산 중 결과를 읽기 가능 상태로 승인하지 않는다.
- 백필 중에도 신규 수집 outbox는 독립적으로 처리한다.
- 관리자 화면은 `15분 기준 대기`와 실제 `진행 정체`를 구분한다.
- 원본과 각 rollup의 정합성 검증이 통과하기 전에는 자동 읽기 전환과 원본 TTL을 허용하지 않는다.
- 기준 장비의 백필 동시 실행 benchmark에서 인증된 대시보드 8개 시나리오가 p95 2초 이하이고 5xx가 없어야 한다.

## 현재 문제와 원인

현재 구현은 15분 worker, 시간대별 worker, 자동 전환 controller를 각각 독립 `setInterval`로 등록한다. 첫 실행용 `setTimeout`만 서로 다른 지연을 사용하고 반복 interval은 거의 같은 시각에 등록된다. 세 작업은 비대기 PostgreSQL advisory lock `toard:rollup-load-slot`을 공유하므로, 먼저 등록된 15분 worker가 매분 잠금을 얻고 나머지 작업은 `busy`로 종료될 수 있다.

실제 v0.15.4 운영 관측에서도 다음 패턴이 확인됐다.

- 시간대별 worker는 앱 시작 직후 한 번만 성공했다.
- 이후 15분 worker만 매분 성공했다.
- 시간대별 worker는 paused나 error가 아니었지만 마지막 진행이 갱신되지 않았다.
- 시간대별 pending 작업은 330개에서 380개로 증가했다.
- 자동 전환 controller의 `last_checked_at`도 앱 시작 시각 이후 갱신되지 않았다.

이는 데이터 오류나 서버 과부하가 아니라 독립 timer와 비대기 잠금의 결합으로 생긴 starvation이다.

## 선택한 접근법

### 채택: 단일 공정 coordinator

독립 반복 timer를 하나의 `RollupCoordinator`로 교체한다. coordinator는 전체 replica에서 하나의 계획만 실행하고, durable 상태를 기준으로 처리 가능한 작업 중 하나를 공정하게 선택한다.

### 제외한 접근법

1. **timer 간격만 분산**: 수정은 작지만 작업 시간이 늘거나 replica가 추가되면 다시 충돌할 수 있어 제외한다.
2. **잠금 실패 시 짧은 재시도**: 충돌 빈도는 줄지만 공정성을 보장하지 못하고 retry 폭주 위험이 있어 제외한다.
3. **모든 작업을 범용 DB queue로 통합**: 확장성은 높지만 현재 worker와 상태 모델을 크게 바꾸므로 이번 범위에는 과하다.

## 전체 구조

```text
신규 수집 outbox ─────────────── 독립 30초 flush

RollupCoordinator ─ 10초마다 깨어남
  ├─ 전역 coordinator 잠금 획득
  ├─ PostgreSQL 상태·watermark·dirty·job 조회
  ├─ 가벼운 자동 전환 상태 조정
  ├─ 무거운 작업 후보 중 하나 선택
  │    ├─ 15분 기준 rollup
  │    ├─ 확정 구간의 시간대별 1시간·1일 rollup
  │    └─ 정합성 검증
  ├─ 선택한 작업 하나 실행
  ├─ 결과와 다음 실행 기준 저장
  └─ 잠금 해제 후 10초 뒤 다음 실행 예약
```

`setInterval` 대신 작업 완료 뒤 다음 `setTimeout`을 예약한다. 한 작업이 오래 걸리면 다음 주기가 자연스럽게 늦어지고 동일 프로세스 안에서 실행이 겹치지 않는다.

전역 PostgreSQL session advisory lock은 기존 이름 `toard:rollup-load-slot`을 그대로 사용한다. 여러 app replica가 동시에 깨어나도 잠금을 얻은 하나만 상태를 계획하고 작업을 실행한다. 구버전 worker도 같은 잠금을 사용하므로 롤링 배포 중 구버전과 신버전의 heavy 작업이 겹치지 않는다. coordinator가 잠금을 소유한 상태에서 호출하는 task adapter는 잠금을 다시 획득하지 않는다. 프로세스나 DB 연결이 종료되면 session lock은 자동 해제된다.

## coordinator 실행 규칙

coordinator는 10초마다 깨어나지만 각 worker와 자동 전환 상태 확인의 기본 최소 간격은 60초다. 10초 wake-up은 작업 실행 주기를 높이기 위한 것이 아니라, 동시에 due가 된 작업을 순서대로 분산하고 잠금 실패 뒤 빠르게 다시 참여하기 위한 것이다.

한 번의 coordinator 실행은 다음 순서를 따른다.

1. 전역 coordinator 잠금을 비대기로 시도한다. 실패한 replica는 상태를 실패로 기록하지 않고 다음 wake-up을 기다린다.
2. worker, cutover, watermark, dirty, timezone job 상태를 읽는다.
3. PostgreSQL 조회만 필요한 가벼운 cutover heartbeat를 수행한다.
4. 정합성 검증이 필요하면 검증 작업을 최우선 후보로 만든다.
5. due 상태인 15분 worker와 처리 가능한 시간대별 worker를 후보로 만든다.
6. 실행 가능한 후보 중 하나만 선택해 처리한다.
7. 결과를 저장하고 잠금을 해제한다.
8. 작업 완료 시점부터 10초 뒤 다음 wake-up을 예약한다.

### 공정성 선택 규칙

후보 우선순위는 다음과 같다.

1. 읽기 전환이나 fallback 판정에 필요한 정합성 검증
2. 처리 가능한 상태로 120초 이상 기다린 worker
3. 기본 60초 실행 간격이 지난 worker 중 마지막 실행 시각이 가장 오래된 worker
4. 마지막 실행 시각까지 같으면 15분 기준 worker

worker 상태에는 `eligible_since`와 실패 backoff용 `next_attempt_at`을 저장한다. coordinator가 처리 가능한 작업을 처음 확인하면 `eligible_since`를 기록하고, 처리 가능한 작업이 없어지면 null로 되돌린다. 120초 starvation 기준은 이 durable 시각으로 판단하므로 재시작이나 replica 변경 뒤에도 유지된다.

시간대별 worker에 처리 가능한 작업이 없으면 후보에서 제외한다. 따라서 `15분 기준 대기` 상태가 15분 worker의 처리량을 불필요하게 나누지 않는다. 반대로 처리 가능한 시간대별 작업이 생기면 늦어도 120초 안에는 선택된다.

## 확정 구간 판정

시간대별 job은 `pending`이라는 이유만으로 실행하지 않는다. 각 job에 원천 구간 끝 시각 `source_to`와 변경 세대 `generation`을 저장한다.

- hour job: `source_to`는 해당 시간대 hour bucket의 다음 경계다.
- day job: `source_to`는 해당 IANA 시간대에서 다음 로컬 날짜가 시작되는 실제 시각이다.
- UTC offset을 고정하거나 day를 24시간으로 계산하지 않는다.
- DST 때문에 23시간·25시간인 날짜와 30분·45분 offset 시간대를 같은 resolver로 처리한다.

job은 다음 조건을 모두 만족해야 처리 가능하다.

```text
status = pending 또는 회수 가능한 오래된 inflight
AND source_to <= usage_15m_v2 watermark
AND [bucket, source_to) 범위에 usage_15m_v2 dirty bucket 없음
```

연속 watermark가 job 끝을 지났고 dirty가 없으면 해당 구간의 모든 15분 버킷이 확정됐다고 판단할 수 있다.

### 중복 계산 감소

15분 worker는 영향을 받은 hour/day job을 기존처럼 unique key로 upsert하되 즉시 실행시키지 않는다. 예를 들어 한 local day의 15분 버킷 96개가 순차 처리돼도 day job은 하나만 pending으로 유지되고, 전체 local day가 확정된 뒤 한 번 처리된다.

늦은 데이터가 들어오면 영향받은 15분 버킷을 dirty로 만들고 해당 hour/day job의 `generation`을 증가시키며 status를 pending으로 되돌린다. 다른 날짜나 시간의 rollup은 건드리지 않는다.

## 처리 중 변경 경쟁 방어

시간대별 worker가 job을 claim할 때 `id`와 `generation`을 함께 가져간다. 계산 완료는 다음 조건을 모두 만족하는 compare-and-set으로 승인한다.

```text
id 일치
status = inflight
generation = claim 시점 generation
현재 watermark가 source_to 이상
해당 범위 dirty bucket 없음
```

계산 중 늦은 데이터가 들어오면 invalidation이 generation을 증가시키고 status를 pending으로 바꾼다. 이전 generation의 worker가 ClickHouse에 결과를 썼더라도 완료 compare-and-set은 실패하고 coverage를 만들지 않는다. 조회 경로는 coverage가 없거나 pending인 구간을 사용하지 않는다. 다음 재처리가 더 높은 version의 결과를 기록한 뒤에만 coverage를 승인한다.

이 규칙은 잘못된 중간 결과가 잠깐이라도 읽기 대상으로 노출되는 것을 막는다.

## 자동 읽기 전환 통합

자동 전환 controller를 독립 heavy timer로 실행하지 않는다. coordinator의 가벼운 상태 조정과 무거운 검증 후보로 분리한다.

- `backfilling`: PostgreSQL watermark·dirty·pending 상태만 확인한다.
- 검증 준비 완료: 다음 heavy 작업 후보로 정합성 검증을 등록한다.
- 검증 성공: 기존처럼 고정 T0를 저장하고 `observing`으로 전환한다.
- `observing`: 60초 간격의 가벼운 heartbeat가 정상 관찰 시간을 누적한다.
- 3,600초 도달: 활성화 전 최종 검증을 heavy 후보로 등록한다.
- 검증 성공: `active`로 전환한다.
- `active`: 기존 6시간 주기 검증을 heavy 후보로 등록한다.
- mismatch: 즉시 `fallback`; 일시 오류는 기존 연속 실패 임계치를 유지한다.

검증은 일반 백필보다 우선하지만 한 coordinator 주기에 heavy 작업 하나만 실행한다. 신규 수집 outbox는 coordinator 잠금을 사용하지 않는다.

## 상태 저장과 관리자 화면

### durable scheduler 상태

PostgreSQL에 단일 행 `clickhouse_rollup_scheduler_status`를 추가한다.

- `last_heartbeat_at`
- `last_selected_task`: `usage_15m_v2 | timezone | validation | idle`
- `last_task_started_at`, `last_task_finished_at`
- `last_task_outcome`: `success | failed | superseded | idle`
- 비밀값을 제거한 `last_error`
- `updated_at`

heartbeat는 매 wake-up마다 쓰지 않고 task 실행 또는 60초 경과 시에만 갱신한다. 잠금을 얻지 못한 replica의 정상적인 skip은 오류나 정체로 기록하지 않는다.

### worker 상태

기존 상태에 `waiting_for_base`를 추가한다.

- `catching_up`: 최근 120초 안에 처리 가능한 작업을 완료했다.
- `waiting_for_base`: pending은 있지만 처리 가능한 job이 0이다.
- `stalled`: 처리 가능한 job이 있는데 120초 이상 선택·진행되지 않았다.
- `error`: 마지막 시도가 실패했고 이후 성공이 없다.
- 기존 `paused`, `disabled`, `ready`, `starting`, `not_applicable`은 유지한다.

기존 worker 상태 행에는 다음 durable scheduling 필드를 추가한다.

- `eligible_since`: 처리 가능한 작업이 처음 관측된 시각
- `next_attempt_at`: 실패 backoff가 끝나는 시각

시간대별 상태 API에는 다음 값을 추가한다.

- `eligiblePendingJobs`
- `waitingForBaseJobs`
- `eligibleSince`
- `lastSchedulerHeartbeatAt`
- `lastSelectedTask`

관리자 화면의 진행률과 ETA는 다음처럼 표시한다.

- 전체 진행률: 기존 coverage와 전체 pending 기준
- 지금 처리 가능: eligible pending 수
- 15분 기준 대기: waiting-for-base 수
- 처리 가능 ETA: eligible pending / 최근 처리량
- 전체 ETA: 15분 ETA와 시간대별 처리 가능 ETA를 합성할 근거가 모두 있을 때만 표시하고, 아니면 `15분 기준 완료 후 계산`으로 표시

전체 Rollup 운영 상태는 처리 가능한 backlog가 있는데 scheduler heartbeat나 진행이 120초 넘게 없으면 `주의`로 바뀐다. 일부 ClickHouse 저장 규모 조회가 실패한 경우에는 기존 degraded-safe snapshot 정책을 유지한다.

## 부하와 속도 보호

- 한 coordinator 주기에서 heavy 작업은 최대 하나다.
- 기존 adaptive batch 범위인 15분 1~64 bucket, 시간대별 1~32 job을 유지한다.
- 요청 한도를 모두 처리하고 2초 이하이면 다음 한도를 25% 늘린다.
- 10초 이상 걸리거나 실패하면 다음 한도를 절반으로 줄인다.
- worker 실패는 다른 worker를 막지 않는다. 실패 worker는 `next_attempt_at`으로 60초부터 최대 5분까지 점진적으로 backoff한다.
- 정합성 mismatch는 retry 부하를 만들지 않고 즉시 fallback으로 전환한다.
- outbox flush는 기존 30초 독립 경로를 유지한다.
- 사용자 조회는 준비된 coverage만 rollup에서 읽고 나머지는 더 세밀한 source로 대체한다.

이 구조는 백필의 순간 최대 처리량보다 예측 가능한 처리량과 사용자 조회 안정성을 우선한다. 확정 전 시간대별 작업을 반복하지 않으므로 전체 계산량은 줄어든다. p95 2초는 구조만으로 선언하지 않고 백필 동시 benchmark로 검증한다.

## 실패와 복구

- app 프로세스 종료: PostgreSQL session lock이 자동 해제되고 다른 replica나 재시작한 프로세스가 이어받는다.
- coordinator 잠금 획득 실패: 정상 경쟁으로 보고 다음 10초 wake-up에서 재시도한다.
- PostgreSQL 오류: 새 heavy 작업을 시작하지 않고 기존 읽기 fallback을 유지한다.
- ClickHouse worker 오류: 오류와 adaptive 감소를 저장하고 다른 후보를 계속 처리한다.
- inflight worker 종료: 기존 5분 회수 규칙으로 pending 처리한다.
- 처리 중 generation 변경: 결과를 `superseded`로 기록하고 coverage를 승인하지 않는다.
- 검증 mismatch: 즉시 fallback으로 전환하고 기존 source를 읽는다.
- 관리자 pause: 후보 생성 단계에서 제외하며 재시작 뒤에도 유지한다.

## 배포와 호환성

1. additive migration으로 `source_to`, `generation`, scheduler 상태를 추가한다.
2. 기존 hour job의 `source_to`는 `bucket + 1시간`으로 채운다.
3. 기존 day job의 `source_to`는 각 job의 IANA 시간대에서 다음 로컬 날짜 경계로 채운다.
4. 새 앱은 기존 독립 15분·시간대별·cutover 반복 timer를 시작하지 않고 coordinator 하나만 시작한다.
5. 기존 watermark, pending job, coverage, worker pause, adaptive limit을 그대로 이어받는다. 전체 백필을 초기화하지 않는다.
6. read override와 raw TTL 환경변수 동작은 변경하지 않는다.
7. migration 후 coordinator가 비정상이면 read는 기존 fallback에 머물고 데이터 삭제는 발생하지 않는다.

롤백 시 additive schema는 남겨도 구버전이 무시할 수 있어야 한다. down migration은 운영 롤백 절차에서 실행하지 않는다. 구버전으로 되돌리면 기존 timer starvation 문제가 다시 생길 수 있으므로, 운영 롤백은 worker pause와 fallback read를 함께 사용하고 수정 버전 재배포를 우선한다.

## 구현 경계

주요 변경 대상은 다음과 같다.

- 신규 `apps/web/lib/rollup-coordinator.ts`와 단위 테스트
- `apps/web/instrumentation.ts`의 scheduler 시작점 통합
- `apps/web/lib/clickhouse-outbox.ts`의 독립 rollup interval 제거와 coordinator-held lock용 task adapter 분리
- `apps/web/lib/timezone-rollup.ts`의 확정 구간 claim과 generation compare-and-set
- `apps/web/lib/rollup-cutover.ts`의 가벼운 상태 조정과 heavy validation 분리
- `apps/web/lib/rollup-worker-state.ts`, `rollup-status.ts`, 관리자 패널의 상태 확장
- PostgreSQL additive migration과 실제 PostgreSQL 통합 테스트
- 운영 runbook과 한국어·영어 문구 갱신

범위에서 제외한다.

- 원본 TTL 자동 활성화
- rollup 물리 테이블 이름 변경
- worker ID 변경
- outbox flush를 coordinator에 포함하는 변경
- CPU·메모리 OS metric 수집 시스템 추가
- 사용자 조회 API 계약 변경

## 검증 기준

### 결정론적 scheduler 테스트

- fake clock으로 30분을 진행했을 때 두 worker가 모두 due이면 각각 120초 이내에 선택된다.
- 15분 worker가 먼저 등록돼도 20회 연속 혼자 선택되지 않는다.
- worker 하나가 10초 이상 걸려도 다음 실행이 겹치지 않는다.
- 두 replica가 동시에 실행해도 heavy task는 한 번만 실행된다.
- paused, disabled, backoff worker는 후보에서 제외된다.
- `eligible_since`는 재시작 뒤에도 유지되고 eligible backlog가 없어지면 초기화된다.
- 검증 후보는 한 번만 실행되고 일반 worker와 동시에 실행되지 않는다.

### 확정 구간과 경쟁 조건 테스트

- watermark 이전 hour/day만 claim한다.
- dirty가 하나라도 있으면 해당 hour/day를 claim하지 않는다.
- `America/Los_Angeles` DST 시작·종료일의 23시간·25시간 day 경계를 검증한다.
- `Asia/Kolkata`, `Asia/Kathmandu`의 30분·45분 offset 경계를 검증한다.
- claim 뒤 invalidation이 발생하면 이전 generation 완료가 coverage를 만들지 않는다.
- 재처리 결과만 최신 coverage로 승인된다.
- 오래된 inflight job은 기존 5분 뒤 회수된다.

### 상태와 복구 테스트

- pending이 있지만 eligible이 0이면 `waiting_for_base`다.
- eligible이 있고 120초 이상 진행이 없을 때만 `stalled`다.
- coordinator heartbeat가 오래됐고 작업이 남아 있으면 전체 상태가 `주의`다.
- 프로세스 종료 뒤 advisory lock이 해제되고 다음 coordinator가 진행한다.
- worker 실패 뒤 다른 worker가 선택되고 실패 worker의 adaptive 한도와 backoff가 적용된다.
- mismatch와 일시 오류의 기존 fallback 규칙을 유지한다.

### 통합·릴리스 검증

- PostgreSQL 16에서 migration up과 기존 job의 `source_to` 변환을 검증한다.
- 원본, 15분, 시간대별 hour/day의 이벤트·토큰·비용·fingerprint 불일치가 0건이다.
- 전체 `pnpm test`, `pnpm typecheck`, `pnpm build`, `git diff --check`를 통과한다.
- 기준 4 vCPU·8 GiB 환경에서 100만 건·400일 fixture와 5개 시간대를 사용한다.
- 백필 coordinator가 실제 실행되는 동안 인증된 대시보드 8개 시나리오를 각 100회 실행한다.
- 각 시나리오 p95가 2초 이하이고 5xx가 없으며 신규 수집 누락·outbox 정체가 없어야 한다.
- 30분 soak 동안 heavy ClickHouse 작업 동시 실행 수가 1을 넘지 않고 처리 가능한 worker의 120초 초과 대기가 없어야 한다.

위 기준을 모두 통과하기 전에는 자동 읽기 전환 완료나 성능 보장을 선언하지 않는다.
