# E2EE Legacy Key Retirement Design

## 목적

모든 사용자의 `server_v1` 프롬프트 기록이 `e2ee_v1`으로 전환된 뒤에도 PostgreSQL 백업·WAL·수동 스냅샷과 서버 KEK가 남을 수 있다. 활성 DB 행의 전환 완료, 백업 보존 만료 확인, 외부 Secret Store의 KEK 제거를 서로 다른 증명 단계로 관리하고 순서를 어긴 배포를 차단한다.

## 기존 동작

- 사용자별 자동 마이그레이션은 `prompt_records`의 동일 행을 원자적으로 `server_v1`에서 `e2ee_v1`으로 갱신한다.
- E2EE 활성 사용자에 대한 신규 `server_v1` 쓰기는 거부한다.
- 사용자 화면은 `server_v1`과 `e2ee_v1` 본문을 혼합하지 않는다.
- 사용자별 완료 조건은 해당 사용자의 `server_v1` 레코드가 0건인 것이다.

## 보호 경계

toard가 책임지는 범위:

- 전체 `server_v1` 잔여 건수 집계
- 전체 0건 최초 관측 시각과 재등장 무효화
- 백업 보존기간 경과 여부와 관리자 확인 기록
- KEK 설정 여부와 잔여 레코드의 교차 검증
- 잘못된 배포의 readiness 차단
- 관리자 UI와 비밀값 없는 감사 이벤트

운영 인프라가 책임지는 범위:

- PostgreSQL 백업, WAL, 복제본, 수동 스냅샷의 실제 만료·삭제
- Docker/Kubernetes/Vercel/Vault 등 외부 Secret Store에서 `TOARD_CONTENT_KEK_B64` 제거

앱은 외부 백업이나 Secret Store를 자동 삭제하지 않는다.

## 상태 모델

전역 singleton `content_legacy_retirement`를 추가한다.

- `zero_observed_at`: 전체 `server_v1`이 처음 0건으로 관측된 시각
- `backup_confirmed_at`: 운영자가 백업·WAL·스냅샷 폐기를 확인한 시각
- `backup_confirmed_by`: 확인한 관리자
- `key_retired_observed_at`: 앱이 KEK 부재를 처음 관측한 시각
- `updated_at`: 최근 상태 변경 시각

감사 테이블 `content_legacy_retirement_events`는 다음 이벤트만 append-only로 기록한다.

- `zero_observed`
- `zero_invalidated`
- `backup_confirmed`
- `key_retired_observed`

각 이벤트에는 시각, 관리자 ID(관리자 동작일 때만), 당시 legacy 건수만 저장한다. 암호문, KEK, 백업 경로는 저장하지 않는다.

## 전이 규칙

1. `legacyRecords > 0`
   - KEK가 유효하면 `migrating`이다.
   - KEK가 없으면 `unsafe_key_missing`이며 readiness가 실패한다.
   - 이전 `zero_observed_at`, 백업 확인, 키 폐기 관측은 모두 무효화한다.
2. `legacyRecords = 0`이고 `zero_observed_at`이 없으면 현재 시각을 기록한다.
3. 백업 보존기간 설정이 없으면 `backup_policy_unconfigured`다.
4. `now < zero_observed_at + retentionDays`이면 `waiting_backup_retention`이다.
5. 기간은 지났지만 관리자 확인이 없으면 `backup_confirmation_required`다.
6. 관리자 확인 후 KEK가 있으면 `ready_to_remove_key`다.
7. 관리자 확인 후 KEK가 없으면 `retired`다.
8. 관리자 확인 전에 KEK가 제거되면 `key_removed_unconfirmed`다. legacy가 0건이므로 서비스는 계속되지만 관리자 경고를 표시한다.

## 보존기간 설정

`TOARD_LEGACY_BACKUP_RETENTION_DAYS`를 추가한다.

- 미설정이면 키 폐기 준비 상태에 진입하지 않는다.
- 정수 0~3650만 허용한다. `0`은 백업을 생성하지 않는 설치에서만 사용한다.
- earliest retirement 시각은 `zero_observed_at + retentionDays`다.
- 시간 경과만으로 충분하지 않다. 수동 스냅샷까지 확인한 관리자의 명시적 확인이 추가로 필요하다.

## 관리자 API와 UI

- `GET /api/admin/content-retirement/status`: 관리자 전용, no-store. 상태와 건수만 반환한다.
- `POST /api/admin/content-retirement/confirm-backup`: 관리자 전용. legacy 0건, 보존기간 설정, 만료시각 경과를 다시 확인한 후 확인을 기록한다.
- 관리 → 시스템에 `레거시 본문 키 폐기` 행을 추가한다.
- UI는 잔여 건수, 전체 0건 최초 확인, 가장 이른 폐기일, 백업 확인, KEK 설정 여부, 최종 상태를 보여준다.
- KEK 값은 API, HTML, 로그 어디에도 포함하지 않는다.

## Readiness 안전장치

`/api/ready`는 기본 DB 연결 확인 후 `server_v1` 전체 건수를 조회한다. 유효한 KEK가 없는데 legacy가 1건 이상이면 HTTP 503을 반환한다. KEK가 남아 있거나 legacy가 0건이면 기존 readiness 동작을 유지한다.

## 후속 릴리스

이번 릴리스는 폐기 가능 상태와 안전장치를 제공하되 legacy 복호화 코드는 제거하지 않는다. 운영자가 백업 확인과 KEK 제거를 완료하고 한 릴리스 동안 `server_v1` 재등장이 없음을 확인한 다음 별도 릴리스에서 다음을 제거한다.

- `server_v1` 복호화 및 수집 호환 코드
- legacy migration API
- `TOARD_CONTENT_KEK_B64` 지원
- 구형 shim의 server-v1 호환 경로

## 테스트 기준

- 상태 계산의 모든 전이를 단위 테스트한다.
- legacy 재등장은 zero/backup/key-retired 상태를 원자적으로 무효화한다.
- 백업 확인 API는 비관리자, 미만료, 잔여 legacy 상태를 거부한다.
- readiness는 `KEK 없음 + legacy 존재`에서만 실패한다.
- migration 31 적용과 rollback을 PostgreSQL 통합 테스트로 검증한다.
- 관리자 UI와 한영 번역 계약을 검증한다.
- 전체 테스트, 타입체크, 프로덕션 빌드를 통과한다.
