# 수집 저장 확인과 장애 복구

사용량 수집은 `원본 로그 → 로컬 사용량 보관함 → 서버 영속 저장 → ACK 확인` 순서로 진행한다. 컴퓨터 연결, 사용량 저장, 대시보드 집계는 서로 다른 단계다.

## 연결과 첫 저장

인증된 요청이 도착하면 연결은 확인된다. 빈 요청이나 수집기의 자체 상태 보고만으로 설치 완료를 표시하지 않는다. `/api/v1/events`와 experimental `/api/v1/logs`가 인증 사용자 소유의 사용량을 확인하면 동일 저장 트랜잭션에서 해당 ingest token의 첫·최근 저장 시간을 기록한다.

PostgreSQL 모드는 usage row, ClickHouse 모드는 PostgreSQL durable outbox row가 기준이다. ClickHouse 장애 중에도 outbox 저장은 확인될 수 있으며, 이 경우 대시보드 집계가 늦을 수 있다. 다른 사용자의 dedup key와 충돌한 요청은 저장 확인으로 세지 않는다.

설정의 수집 상태 표는 서버가 확인한 마지막 저장과 기기가 보고한 최근 실행 상태를 나누어 보여준다. `—`는 미확인 값이고 `0`은 이번 실행에서 관측한 0이다. 새 기록이 없다는 상태는 사람의 AI 미사용을 뜻하지 않는다. 상태 보고가 늦으면 현재 상태를 판단할 수 없다.

## 로컬 사용량 보관함

서버마다 `~/.toard/targets/<sha256(endpoint)>/state/usage-queue.sqlite3`를 만든다. 정규화한 사용량 메타데이터만 저장하며 프롬프트·응답 본문·도구 인자·ingest token은 넣지 않는다. SQLite WAL과 `synchronous=FULL`을 사용한다. 읽기 위치는 해당 관측분이 모두 commit된 뒤 갱신한다.

- 프로세스가 종료되거나 원본 로그가 삭제되어도 **이미 보관한 사용량**은 재전송한다.
- 서버가 저장했지만 응답이 유실되면 같은 키를 재전송한다. 서버 dedup과 인증 사용자 소유 여부를 확인한 뒤 큐에서 제거한다.
- 일부만 확인된 응답, 계정 불일치, 읽기 오류는 큐를 보존한다. 자동으로 삭제하거나 다른 계정으로 옮기지 않는다.
- 기본 한도는 pending payload 합계 64MiB다. `TOARD_SHIM_QUEUE_MAX_BYTES`로 1KiB~1GiB를 설정할 수 있다. DB index·WAL 등 디스크 사용량은 이 값보다 크다.
- 보관함이 가득 차면 더 이상 넣지 못한 범위의 source cursor를 전진시키지 않는다. 원본 파일을 보존하고 서버 연결·대기량을 확인한다.
- 파싱 오류가 있는 파일은 정상 레코드를 전송하더라도 해당 파일의 cursor를 전진시키지 않는다. 작성 중인 마지막 JSONL 줄이 완성되거나 손상 부분이 수정되면 다시 읽는다.

보관 전에 삭제된 로그, 디스크 자체 손실, 명시적으로 제거한 target의 상태, 본문과 도구 활동은 이 보장에 포함되지 않는다. 보관함은 백업이 아니며 서버의 retention 또는 provider 수집 정책도 무시하지 않는다.

`toard-shim doctor`는 payload를 읽지 않고 대기 건수와 bytes를 보여준다. 웹 설정의 **이 컴퓨터 제어**에서도 새 shim의 큐 상태를 확인할 수 있다. 큐 파일을 읽지 못할 때 자동 재생성하지 않으므로 오류가 발생한 파일을 보존한다.

## ACK와 계정 경계

`POST /api/v1/collection-status`의 schemaVersion 1 handshake는 인증된 `userId`와 `eventsReceiptVersion: 1`을 반환한다. 큐는 endpoint와 검증한 owner에 묶인다. owner가 같은 토큰 교체는 가능하지만 대기 데이터가 있는 상태에서 다른 owner로 바꿀 수는 없다.

오프라인 또는 구버전 서버에서 최초 생성한 큐는 token의 SHA-256 fingerprint에 묶인다. owner를 확인하기 전에 token이 바뀌면 대기 데이터를 새 계정에 보낼 수 없으므로 전송을 멈춘다. 기존 연결을 복원하거나 대기 기록의 처리 방침을 먼저 정해야 한다.

`/events` 성공 응답의 의미:

| 필드 | 의미 |
|---|---|
| inserted | 새로 저장한 사용량 |
| deduped | 요청에서 중복으로 처리된 사용량 |
| confirmed | 인증 사용자 소유의 실제 usage/outbox에서 확인한 요청 키 수 |
| expired | 서버 보존 기간 밖이라 저장하지 않은 요청 |
| ignored | 현재 provider 수집 방식이 달라 저장하지 않은 요청 |

새 shim은 `inserted+deduped+expired+ignored`와 `confirmed+expired+ignored`가 각각 전송 건수와 일치하는지 확인한다. `expired`와 `ignored`는 저장 성공이 아니라 서버의 명시적인 제외 결정이다. 새 handshake를 지원하지 않는 이전 서버에는 기존 `inserted+deduped` 계약을 적용한다. 새로운 handshake를 한 번 확인한 큐는 이후 owner 확인 ACK 없이 정리하지 않는다.

## 배포 순서와 검증 범위

서버 migration `1700000055`와 앱을 먼저 적용하고 shim을 업데이트한다. 이전 shim의 요청은 계속 수신하지만 자체 health 보고와 로컬 보관함은 shim 업데이트 뒤에 생긴다. 기존에 손실된 사용량을 새 큐가 복원하지는 않는다.

회귀 검증은 합성 데이터와 임시 DB로 수행한다.

- `scripts/collection-receipts.integration.test.ts`: 실제 PostgreSQL 트랜잭션, 인증·빈 요청·다른 소유자 충돌·실패 rollback·ClickHouse outbox 저장 경계.
- `shim/rust/tests/usage_queue_cli.rs`: 실제 CLI·curl·loopback HTTP에서 장애, 재시작, 원본 삭제, 저장 후 ACK 유실, 중복 방지, 손상된 로그 재시도.
- `tests/browser/trust.spec.ts`: 연결 확인 뒤 첫 저장까지 설치 화면이 기다리는지 검증.

이 테스트는 운영 환경의 장애 복구 훈련이나 외부 팀 파일럿을 대체하지 않는다.
