# 팀 소속 이력과 사용량 귀속 설계

## 배경

현재 toard는 `users.team_id`의 현재값을 사용량 수집 시 조회해 `usage_events.team_id`에 저장한다. 팀 현황은 이벤트에 저장된 `team_id`를 직접 집계하므로, 팀 없이 사용량을 먼저 수집한 사용자를 나중에 팀에 배정해도 기존 이벤트는 계속 미배정으로 남는다.

또한 현재 방식은 이벤트 발생 시각이 아니라 서버 수집 시각의 소속을 사용한다. 과거 로컬 로그가 팀 이동 후 늦게 도착하면, 실제 발생 당시가 아니라 새 팀에 귀속될 수 있다.

## 결정

팀 귀속은 다음 두 원칙을 함께 적용한다.

1. **최초 팀 배정은 기존 미배정 사용량을 모두 소급 귀속한다.** 팀 선택보다 설치·수집이 먼저 진행된 초기 설정 지연을 보정한다.
2. **최초 배정 이후의 팀 변경은 소급하지 않는다.** 이벤트 발생 시각에 유효했던 팀 소속을 유지한다.

구체적인 의미는 다음과 같다.

| 변경 | 과거 이벤트 | 변경 이후 이벤트 |
|---|---|---|
| `팀 없음 → 최초 팀` | 기존 미배정 이벤트를 새 팀에 귀속 | 새 팀에 귀속 |
| `A팀 → B팀` | A팀 유지 | B팀에 귀속 |
| `A팀 → 팀 없음` | A팀 유지 | 미배정 |
| `팀 없음 → 재배정` | 기존 귀속과 미배정 기간을 그대로 유지 | 재배정 팀에 귀속 |

`팀 없음 → 재배정`은 최초 배정과 다르다. 한 번이라도 팀 소속 이력이 있으면 자동 소급하지 않는다.

## 목표

- 최초 팀 배정 직후 기존 사용량이 팀 현황에 자연스럽게 나타난다.
- 팀 이동이나 해제로 과거 팀 실적이 바뀌지 않는다.
- 늦게 도착한 이벤트도 수집 시각이 아닌 이벤트 발생 시각의 팀에 귀속된다.
- PostgreSQL과 ClickHouse 저장 모드가 같은 귀속 의미를 제공한다.
- 대량 백필은 재시도 가능하고, 웹 요청 시간에 묶이지 않는다.
- 기존 설치에 추정 기반의 자동 소급 변경을 하지 않는다.

## 범위 제외

- 관리자가 임의의 과거 기간을 다른 팀으로 재분류하는 범용 편집기
- 한 사용자가 같은 시각에 여러 팀에 속하는 모델
- 팀 귀속을 비용 청구나 급여·성과평가의 법적 원장으로 사용하는 기능
- 기존의 팀 귀속이 이미 있는 이벤트를 일괄 재판정하는 마이그레이션

## 데이터 모델

### 현재 팀

`users.team_id`는 현재 팀을 빠르게 표시하고 기존 권한·UI와 호환하기 위한 캐시로 유지한다. 팀 변경 서비스만 이 값을 수정할 수 있다.

### 팀 소속 이력

기존의 비활성 `user_team_assignments` 테이블을 활성화하고 날짜 단위를 시각 단위로 바꾼다.

최종 스키마는 다음 형태가 된다. 실제 마이그레이션은 기존 row를 먼저 보정한 뒤 제약을 강화한다.

```sql
ALTER TABLE user_team_assignments
  ALTER COLUMN effective_from TYPE TIMESTAMPTZ,
  ALTER COLUMN effective_to TYPE TIMESTAMPTZ;

ALTER TABLE user_team_assignments
  ADD COLUMN assignment_kind TEXT NOT NULL,
  ADD COLUMN created_by UUID REFERENCES users(id),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
```

기존 테이블은 현재 제품 코드에서 쓰지 않지만 외부 설치에 수동 데이터가 있을 수 있다. 날짜값은 UTC 자정으로 명시 변환하고, 새 컬럼은 nullable로 추가한 뒤 기존 row를 `legacy_seed`로 채우고 마지막에 `NOT NULL` 제약을 건다. 암묵적인 세션 타임존 cast는 사용하지 않는다.

`assignment_kind`는 `onboarding`, `admin`, `legacy_seed` 중 하나다. 최초 소속의 시작은 `-infinity`로 저장해 나중에 더 오래된 로그가 도착해도 최초 팀에 귀속되도록 한다. 이후 소속은 실제 변경 시각을 `effective_from`으로 사용한다. 기간은 `[effective_from, effective_to)`로 해석한다.

한 사용자의 소속 기간이 겹치지 않도록 `btree_gist` 확장과 exclusion constraint를 필수 스키마 계약으로 사용한다. 사용자별 현재 열린 소속은 하나만 존재하도록 partial unique index도 둔다. 애플리케이션 잠금만으로 기간 겹침을 방지하는 fallback은 두지 않는다.

### 귀속 백필 작업

대량 변경을 웹 요청에서 직접 수행하지 않도록 PostgreSQL에 `team_attribution_jobs`를 둔다.

필수 필드는 다음과 같다.

- `id`, `assignment_id`, `user_id`, `team_id`
- `kind`: `initial_backfill`, `legacy_adoption`
- `status`: `pending`, `running`, `succeeded`, `failed`
- `cutoff_to`: 최초 소속이 종료되면 그 시각, 아니면 `infinity`
- `matched_events`, `updated_events`, `processed_events`
- `last_error`, `attempts`, `created_at`, `started_at`, `finished_at`

소속 이력과 작업 종류별 백필 작업은 하나만 존재하도록 `(assignment_id, kind)` unique constraint를 둔다. worker는 작업을 작은 batch로 처리하며 같은 작업을 다시 실행해도 결과가 달라지지 않아야 한다.

## 팀 변경 서비스

관리 화면과 최초 팀 선택 온보딩은 직접 `UPDATE users`를 실행하지 않고 하나의 `changeUserTeam` 서비스를 사용한다.

서비스는 다음 순서로 동작한다.

1. 대상 사용자 row와 현재 열린 소속 이력을 잠근다.
2. 대상 팀이 존재하는지 검증한다.
3. 기존 소속 이력 존재 여부로 최초 배정인지 판정한다.
4. 현재 열린 소속이 있으면 변경 시각으로 닫는다.
5. 새 팀이 있으면 새 소속 이력을 연다.
   - 최초 배정: `effective_from = '-infinity'`
   - 이후 배정: `effective_from = 변경 시각`
6. `users.team_id`를 같은 transaction에서 갱신한다.
7. 최초 배정이면 `initial_backfill` 작업을 같은 transaction에서 등록한다.
8. commit 후 대시보드와 관리 경로를 무효화한다.

동일 팀을 다시 선택하면 no-op으로 처리한다. 최초 배정의 판정은 `users.team_id IS NULL`만으로 하지 않고 소속 이력이 한 번도 없는지까지 확인한다.

## 신규 이벤트 귀속

PostgreSQL 저장과 ClickHouse outbox 등록은 현재 `users.team_id` 조회 대신 이벤트의 `ts`에 해당하는 소속 이력을 조회한다.

```text
effective_from <= event.ts
AND (effective_to IS NULL OR event.ts < effective_to)
```

일치하는 소속이 없으면 `team_id = NULL` 또는 ClickHouse의 빈 문자열로 저장한다. 따라서 팀 해제 기간의 이벤트는 미배정으로 유지되고, 팀 이동 후 늦게 들어온 과거 이벤트는 당시 팀으로 들어간다.

팀 변경과 수집이 동시에 일어나는 경계를 결정적으로 만들기 위해 두 경로가 `pg_advisory_xact_lock` 기반의 사용자별 동일한 transaction lock을 사용한다. 여러 사용자를 한 batch에서 처리할 때는 사용자 ID를 정렬해 잠금 순서를 고정한다. 해시 충돌은 서로 무관한 사용자를 잠시 직렬화할 뿐 귀속 결과를 바꾸지 않는다.

## 최초 배정 백필

### 공통 선택 조건

백필 대상은 다음 조건을 모두 만족하는 이벤트다.

- `user_id`가 대상 사용자와 같다.
- 현재 `team_id`가 미배정이다.
- 이벤트 발생 시각이 최초 소속 기간 안에 있다.

이미 다른 팀에 귀속된 이벤트는 절대 변경하지 않는다. 사용자가 백필 도중 팀을 이동하거나 해제하면 worker는 최신 `effective_to`를 다시 읽고 그 이전 이벤트만 처리한다.

### PostgreSQL 모드

- `usage_events`를 기본키 기준의 제한된 batch로 `team_id IS NULL` 조건과 함께 갱신한다.
- 영향받은 날짜를 dirty로 표시하고 현재 비서빙 mart를 포함한 팀 일별 집계를 재계산 가능 상태로 만든다.
- 매 batch마다 진행 수를 기록하고 commit한다.
- 대상이 0건이 될 때까지 반복한 뒤 한 번 더 확인하고 작업을 완료한다.

### ClickHouse 모드

ClickHouse의 `usage_events`는 `dedup_key` 기준 `ReplacingMergeTree(inserted_at)`이므로 기존 가격 복구 패턴과 같은 교체 삽입을 사용한다.

1. 아직 전달되지 않은 `clickhouse_usage_outbox` 행은 PostgreSQL transaction에서 `team_id`를 직접 갱신한다.
2. 이미 전달된 ClickHouse 행은 `FINAL`로 제한된 batch를 읽는다.
3. 같은 `dedup_key`와 새 `team_id`로 다시 삽입해 최신 행이 이기게 한다.
4. 영향받은 15분·시간대 rollup bucket을 교체 전후에 dirty로 표시한다.
5. rollup은 raw 이벤트에서 해당 bucket 전체를 다시 계산한다.

worker가 중단되어 일부 batch만 반영돼도 다음 실행은 아직 미배정인 행만 다시 선택한다. 대시보드가 rollup을 읽는 동안 dirty bucket은 raw fallback을 사용해 오래된 팀 집계를 노출하지 않는다.

#### raw TTL 이후의 rollup-only 기간

ClickHouse는 정규화 raw 이벤트를 물리적으로 97일 뒤 삭제할 수 있지만 팀 대시보드용 rollup은 최대 400일 유지한다. 따라서 최초 배정의 "기존 미배정 사용량 전부"는 raw가 남은 구간만 고쳐서는 충족되지 않는다.

raw가 없는 bucket은 다음 절차로 모든 활성 rollup 레이어를 직접 보정한다.

1. 작업 ID별 `team_attribution_rollup_staging`에 대상 사용자의 미배정 rollup row와 새 `team_id`를 복사한다.
2. PostgreSQL에 대상 기간의 read fence를 등록한다. fence가 있는 동안 팀·워크스페이스 화면은 영향받은 기간의 수치를 제공하지 않고 `과거 사용량 귀속 중` 상태를 표시한다.
3. 기존 미배정 rollup row를 제한된 bucket 단위 mutation으로 동기 삭제한다.
4. staging의 같은 지표 row를 새 `team_id`와 새 version으로 삽입한다.
5. 원본 미배정 row가 0이고 교체 row가 모두 존재하는지 검증한 뒤 read fence를 해제한다.
6. 검증이 실패하면 staging을 보존한 채 작업을 `failed`로 두어 동일 자료로 재시도한다.

대상은 15분 v2, 활성 시간대별 1시간·1일 rollup과 실제 읽기에 사용될 수 있는 기존 rollup을 모두 포함한다. sorting key에 `team_id`가 포함되어 있으므로 단순 교체 삽입만으로는 기존 미배정 key가 사라지지 않는다. staging, 동기 삭제, 교체 삽입, read fence가 모두 필요한 이유다.

raw 기반 재계산은 bucket의 전체 source 구간이 raw 보존 범위 안에 있다는 coverage가 확인된 경우에만 사용한다. TTL 경계에 걸려 일부 raw만 남은 bucket은 rollup-only 절차로 처리해 부분 원본으로 집계를 덮어쓰지 않는다.

## 관리 화면

팀 선택을 즉시 저장하는 현재 UI를 다음처럼 바꾼다.

1. 팀을 선택하면 서버가 변경 유형과 미배정 이벤트 개수·기간·토큰·비용을 미리 계산한다.
2. 최초 배정이고 대상이 있으면 확인 대화상자를 표시한다.
3. 대화상자에는 새 팀, 대상 이벤트 수, 기간, 예상 토큰·비용을 보여준다.
4. 확인 후 팀 배정과 백필 작업을 등록한다.
5. 멤버 행에는 `과거 사용량 귀속 중`, 진행 수, 완료 또는 실패 상태를 표시한다.

확인 문구의 기본 형태는 다음과 같다.

> `{팀}`에 배정하며 기존 미배정 사용량 `{이벤트 수}`건도 함께 귀속합니다. 이미 다른 팀에 귀속된 사용량은 변경하지 않습니다.

최초 팀 선택 온보딩도 같은 정책을 적용한다. 별도 modal은 띄우지 않고 팀 선택 화면 자체에 미배정 이벤트 수·기간과 함께 귀속된다는 설명을 표시한다. 사용자가 그 설명을 본 상태에서 선택 버튼을 누르는 것을 확인 동작으로 본다.

## 기존 설치 전환

마이그레이션은 기존 이벤트의 `team_id`를 자동 변경하지 않는다.

- 현재 팀이 있는 사용자에게는 `legacy_seed` 소속을 `-infinity`부터 열린 기간으로 생성해 기존 수집 의미를 보존한다.
- 현재 팀이 없는 사용자는 소속 이력을 만들지 않는다. 이후 첫 팀 배정이 최초 배정 정책을 사용한다.
- 이미 팀이 있는 사용자의 기존 미배정 이벤트는 자동 백필하지 않는다.
- 관리 화면에서 `기존 미배정 사용량 귀속`이라는 `legacy_adoption` 작업을 명시적으로 실행할 수 있게 하며, 실행 전 대상 수치를 보여준다.
- 이 명시적 작업도 현재 팀에만, 아직 미배정인 이벤트에만 적용한다.

이 정책은 기존 설치의 과거 조직 변화를 추측하지 않으면서 현재 개인 설치처럼 이미 배정을 마친 직후의 미배정 이력을 안전하게 보정할 수 있게 한다.

## 실패 처리와 일관성

- 팀 현재값, 소속 이력, 백필 작업 등록은 하나의 PostgreSQL transaction이다.
- 팀 배정 자체가 성공하면 백필 worker 실패로 되돌리지 않는다. 관리 화면에서 실패와 재시도를 노출한다.
- worker는 제한된 batch, 재시도 횟수, 마지막 오류를 기록한다.
- PostgreSQL update와 ClickHouse 교체 삽입은 대상이 여전히 미배정인지 확인해 멱등성을 유지한다.
- 다른 팀에 이미 귀속된 행을 발견하면 건너뛰고 충돌 건수만 관측 지표로 남긴다.
- 팀 삭제는 현재 멤버·귀속 이벤트뿐 아니라 소속 이력이 남아 있어도 차단한다.
- preview와 실행 사이에 대상 수가 변할 수 있으므로 확인 화면의 수치는 예상값으로 표시하고, 완료 수치는 작업 결과를 권위값으로 사용한다.

## 관측성

관리 화면과 구조화 로그에 다음 항목을 노출한다.

- 작업 ID, 사용자 ID, 대상 팀 ID, 상태와 시도 횟수
- 예상·처리·갱신·충돌 이벤트 수
- 최초·최종 대상 이벤트 시각
- 영향받은 PostgreSQL 날짜와 ClickHouse dirty bucket 수
- 처리 시간과 마지막 오류 코드

이메일, 토큰, 자격 증명, 이벤트 본문은 로그에 남기지 않는다.

## 테스트 기준

### 정책 단위 테스트

- 소속 이력이 없는 `NULL → 팀`은 `-infinity` 최초 소속과 백필 작업을 만든다.
- 과거 소속이 있는 `NULL → 팀`은 변경 시각부터 새 소속을 만들고 백필하지 않는다.
- `A → B`, `A → NULL`, 동일 팀 재선택의 기간 경계가 정확하다.
- 존재하지 않는 팀, 겹치는 소속 기간, 비관리자의 변경 요청을 거부한다.

### 수집 테스트

- 현재 시각보다 오래된 이벤트가 당시 소속 팀에 귀속된다.
- 팀 해제 기간의 이벤트는 미배정이다.
- 팀 이동 경계 시각은 `[from, to)` 규칙에 따라 새 팀에 귀속된다.
- 팀 변경과 수집이 동시에 실행돼도 이벤트가 경계 양쪽 중 정확히 한쪽에만 귀속된다.

### PostgreSQL 백필 테스트

- 최초 배정은 대상 사용자의 미배정 이벤트만 갱신한다.
- 다른 사용자와 다른 팀의 이벤트는 변경하지 않는다.
- 중단 후 재실행해도 중복 집계가 생기지 않는다.
- 백필 중 팀 이동 시 최초 소속 종료 시각 이후 행을 건드리지 않는다.

### ClickHouse 백필 테스트

- pending outbox 행과 이미 전달된 행이 같은 정책으로 보정된다.
- 같은 `dedup_key`의 최신 교체 행만 `FINAL` 결과에 남는다.
- 교체 전후 rollup dirty 표시와 raw fallback이 동작한다.
- worker 재시도와 ClickHouse 일시 실패가 중복 사용량을 만들지 않는다.
- raw TTL 경계에 걸린 bucket은 부분 raw 재계산 대신 rollup staging 경로를 사용한다.
- rollup-only 보정 중 read fence가 수치 노출을 막고, 검증 성공 후에만 해제된다.

### UI·통합 테스트

- 최초 배정 preview가 이벤트 수·기간·토큰·비용을 표시한다.
- 확인 후 진행 상태가 나타나고 완료 뒤 팀 현황에 기존 사용량이 포함된다.
- 일반 팀 이동에는 소급 귀속 문구가 나타나지 않는다.
- 기존 설치의 명시적 보정은 확인 없이 실행되지 않는다.
- PostgreSQL과 ClickHouse 모드의 팀 현황 합계가 동일한 fixture에서 일치한다.

## 배포 순서

1. 소속 이력 스키마와 백필 작업 테이블을 추가하고 기존 현재 팀을 `legacy_seed`로 등록한다.
2. 팀 변경을 공통 서비스로 전환하되 기존 이벤트는 변경하지 않는다.
3. 신규 수집의 귀속을 이벤트 시각 기반 이력 조회로 전환한다.
4. 백필 worker와 backend별 보정 로직을 배포한다.
5. 관리 preview·확인·진행 UI를 배포한다.
6. PostgreSQL과 ClickHouse 통합 검증 후 기존 설치용 명시적 보정 기능을 활성화한다.

각 단계는 이전 단계와 호환되어야 하며, worker가 배포되기 전 생성된 작업도 이후 정상 처리할 수 있어야 한다.
