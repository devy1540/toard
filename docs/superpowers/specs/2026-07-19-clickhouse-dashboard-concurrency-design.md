# ClickHouse 조직 대시보드 동시성 근본 개선 설계

## 목적

조직 전체 현황(`/org`)을 열 때 한 Server Components render가 ClickHouse 동시 query 제한을 스스로 초과할 수 있는 구조를 제거한다. 단순히 서버 제한을 높이는 대신 화면에 필요한 집계를 저장소 API에서 묶고, 애플리케이션의 ClickHouse 동시 실행량에 상한을 둔다.

성공 기준은 다음과 같다.

- 캐시가 비어 있고 팀 순위가 표시되는 최악 조건에서도 `/org`의 핵심 dashboard query는 ClickHouse 요청 두 개 이하다.
- 한 앱 프로세스가 동시에 실행하는 ClickHouse 작업(query, command, insert)은 네 개 이하다.
- readiness, 수집 flush, rollup을 포함한 앱의 ClickHouse 작업을 공통 상한 안에 넣고, 현재 서버 제한 `max_concurrent_queries_for_user=6`보다 두 자리 낮게 운용한다.
- 도구 활동 또는 AI 활용 지수의 선택적 집계가 실패해도 핵심 사용량 화면은 표시한다.
- 핵심 사용량 집계가 실패하면 기존 dashboard error boundary를 사용하되, 서버에는 원인을 식별할 수 있는 안전한 구조화 로그를 남긴다.
- PostgreSQL과 ClickHouse 저장 모드는 같은 조직 dashboard 결과 계약을 제공한다.
- DB schema 변경이나 기존 사용량 데이터 migration 없이 배포하고, 앱 버전만 되돌려 rollback할 수 있다.

## 확인된 현재 구조와 원인

`apps/web/app/(dashboard)/org/page.tsx`의 `OverviewTab`은 하나의 `Promise.all`에서 현재 개요, 이전 개요, 시계열, 사용자 순위, 팀 순위, provider 분해를 동시에 요청한다. 관리자가 팀 순위를 볼 수 있으면 이 여섯 항목이 모두 저장소 query가 된다.

같은 `Promise.all`에 포함된 `getCachedOrganizationUtilization()`은 10분 캐시가 비었을 때 `getOrganizationUtilizationUsage()`를 추가로 실행한다. 따라서 한 render가 ClickHouse read를 최대 일곱 개까지 거의 동시에 시작할 수 있다.

반면 `clickhouse/users.d/toard-limits.xml`은 기본 사용자에 `max_concurrent_queries_for_user=6`을 설정한다. `packages/storage-clickhouse/src/storage.ts`의 `queryJson()`에는 애플리케이션 동시성 제어가 없고, 현재 retry 대상도 네트워크 오류 코드뿐이다. ClickHouse의 동시 query 초과 오류는 즉시 reject되므로 한 render의 fan-out만으로도 실패 조건을 만들 수 있다.

화면의 `apps/web/app/(dashboard)/error.tsx`는 Server Components 예외를 공통 문구로 변환한다. 운영 build의 브라우저 console은 민감 정보 보호를 위해 실제 서버 오류를 숨기므로 screenshot만으로 특정 발생 건의 ClickHouse 오류 코드를 확정할 수는 없다. 다만 현재 코드의 최대 동시 read 수 7과 서버 제한 6의 불일치는 재현 가능한 구조적 결함이다.

## 접근법 비교

### 채택: dashboard 집계 묶음 + 프로세스 내부 operation gate

조직 dashboard가 요구하는 핵심 집계를 저장소 단위 API로 묶어 ClickHouse 왕복과 동시 실행 수를 줄인다. 모든 ClickHouse client 작업은 공통 FIFO gate를 지나게 해 다른 route나 background 작업이 겹쳐도 한 프로세스의 동시 작업 수가 네 개를 넘지 않게 한다.

이 방식은 한 화면이 제한보다 많은 query를 한꺼번에 발행하는 직접 원인을 제거하고, 다른 화면이나 background 작업과 겹치는 순간의 burst도 흡수한다. 기존 서버 제한 6은 안전망으로 남긴다.

### 제외: ClickHouse 제한만 상향

`max_concurrent_queries_for_user`를 7 이상으로 높이면 현재 화면은 우연히 통과할 수 있지만, render 수나 app replica가 늘면 같은 문제가 다시 생긴다. query 수, CPU, memory burst도 그대로여서 근본 개선이 아니다.

### 후속 선택지: ClickHouse workload scheduler

ClickHouse의 workload/resource scheduling은 여러 앱 replica와 background workload까지 서버에서 공정하게 조절할 수 있다. 그러나 ClickHouse 버전, workload 분류, 운영 정책 변경이 필요하다. 이번 변경은 현재 단일 앱 프로세스가 일으키는 self-overflow를 먼저 제거하며, replica가 늘어날 때 별도 인프라 개선으로 진행한다.

## 범위

이번 변경은 다음을 포함한다.

- 조직 dashboard 전용 저장소 결과 계약
- ClickHouse의 묶음 집계 query와 결과 분배
- PostgreSQL의 동일 결과 계약 구현
- ClickHouse query/command/insert 공통 동시성 gate
- ClickHouse 과부하 오류의 제한적 분류와 retry
- `/org`의 핵심/선택 데이터 실패 격리
- query 수, 동시성, 실패 격리를 검증하는 테스트와 운영 로그

다음은 범위에서 제외한다.

- ClickHouse 동시 query 제한 상향
- ClickHouse 업그레이드 또는 workload scheduler 도입
- usage schema, rollup schema, 수집 pipeline 변경
- 다른 dashboard의 저장소 API 통합
- 여러 Node.js 프로세스 또는 replica를 아우르는 분산 semaphore
- 화면 디자인과 정상 상태의 수치 계산 방식 변경

## 저장소 결과 계약

`packages/core/src/storage.ts`에 다음 의미의 타입과 메서드를 추가한다. 실제 이름은 구현 시 기존 naming convention에 맞추되 필드는 이 계약을 유지한다.

```ts
export interface OrganizationDashboardQuery {
  current: PeriodQuery & BucketOptions;
  previous: PeriodQuery;
  includeTeamLeaderboard: boolean;
  leaderboardOrder: LeaderOrder;
}

export interface OrganizationDashboardData {
  overview: OverviewStats;
  previousOverview: OverviewStats;
  daily: DailyPoint[];
  topUsers: LeaderRow[];
  topTeams: LeaderRow[];
  providerBreakdown: ProviderBreakdown[];
}

getOrganizationDashboard(q: OrganizationDashboardQuery): Promise<OrganizationDashboardData>;
```

현재 기간의 provider, timezone, bucket, from/to 값은 `current`에서 한 번 전달한다. 이전 기간은 비교 개요에 필요한 from/to와 같은 provider 조건을 가진다. 팀 순위를 볼 수 없는 사용자는 `includeTeamLeaderboard=false`로 전달하고 결과는 빈 배열이다.

기존 `getOverview`, `getDailyTimeseries`, `getLeaderboard`, `getProviderBreakdown`은 다른 화면의 호환성을 위해 유지한다. 새 API는 `/org`의 여러 기존 호출을 한 번에 표현하는 orchestration boundary다.

## ClickHouse 집계 설계

### query 묶음

`ClickHouseStorage.getOrganizationDashboard()`는 현재와 이전 기간의 canonical/rollup source를 각각 한 번 결정하고 parameter namespace를 분리한 tagged source를 만든 뒤 핵심 집계를 최대 두 query로 실행한다. 현재 기간 source는 두 묶음이 같은 선택 결과를 사용하며, 이전 기간 source는 비교 개요에만 포함한다.

1. 사용량 묶음: 현재 개요, 이전 개요, 현재 기간 시계열
2. 분해 묶음: 사용자 순위, 선택적인 팀 순위, provider 분해

각 묶음은 `UNION ALL`, 고정된 `result_kind` 판별자, branch 사이에서 타입이 일치하는 nullable superset column을 사용해 JSONEachRow 결과를 반환한다. 예를 들어 사용량 묶음의 행은 `current_overview`, `previous_overview`, `daily` 중 하나이며, 분해 묶음은 `user_leader`, `team_leader`, `provider` 중 하나다. 구현은 판별자별 필수 필드를 검증하고 기존 공개 타입으로 변환한다.

두 query는 서로 독립이므로 `Promise.all`로 실행할 수 있다. 한 `/org` render가 핵심 dashboard 때문에 점유하는 ClickHouse slot은 최대 두 개다. 팀 순위가 비활성화되면 SQL branch 자체를 제외해 불필요한 집계를 실행하지 않는다.

기존 집계 메서드에서 사용하는 다음 규칙은 공통 helper로 추출하거나 그대로 재사용한다.

- runtime read state에 따른 raw/rollup source 선택
- provider와 team 조건
- 조직 timezone bucket 경계
- 비용 coverage와 legacy/unpriced count
- 사용자·팀 이름을 PostgreSQL metadata와 합치는 label map
- leaderboard limit와 order

query 통합은 결과 의미를 바꾸기 위한 것이 아니다. 기존 메서드와 새 묶음 API를 같은 입력으로 호출했을 때 정렬, 합계, coverage가 같아야 한다.

### PostgreSQL 구현

`PostgresStorage.getOrganizationDashboard()`는 우선 기존 검증된 메서드를 조합해 동일 계약을 제공한다. PostgreSQL 모드의 query consolidation은 이번 장애 원인과 무관하므로 필수 범위가 아니다. 호출자는 저장소 종류를 구분하지 않는다.

## ClickHouse operation gate

모든 `this.ch.query`, `this.ch.command`, `this.ch.insert` 호출을 하나의 프로세스 단위 FIFO gate로 감싼다. 기본 동시 실행 상한은 4다. 공통 `runClickHouseOperation()` helper를 두고 기존 직접 호출도 이 helper를 사용하도록 바꿔 우회 경로를 남기지 않는다.

- slot이 있으면 즉시 실행한다.
- slot이 없으면 FIFO queue에서 기다린다.
- query가 resolve 또는 reject되면 반드시 `finally`에서 slot을 반환하고 다음 대기자를 깨운다.
- 대기 시간이 5초를 넘으면 ClickHouse에 query를 보내지 않고 typed admission timeout 오류를 반환한다.
- 취소되거나 timeout된 항목은 queue에서 제거되어 뒤 항목을 막지 않는다.

동시 실행 상한 4는 현재 서버 제한 6보다 작아 같은 ClickHouse 사용자의 다른 프로세스나 운영 점검을 위한 최소 두 slot을 남긴다. readiness, outbox flush, rollup coordinator도 앱 프로세스 안에서는 같은 FIFO gate를 사용하므로 dashboard와 합쳐 네 slot을 공정하게 나눠 쓴다. 이 gate는 프로세스 내부 안전장치이며 여러 app replica 사이를 조정하지 않는다. replica를 늘릴 때는 replica당 상한을 서버 budget에 맞춰 재계산하거나 ClickHouse workload scheduler를 도입해야 한다.

`ensureSchema()`는 gate를 점유하기 전에 완료하고, schema DDL 각각은 공통 helper를 통해 실행한다. 이렇게 해야 네 read가 slot을 잡은 채 schema 초기화 command를 기다리는 교착을 만들지 않는다. PostgreSQL outbox 작업 자체는 ClickHouse gate 대상이 아니지만, outbox가 실행하는 ClickHouse insert는 대상이다.

## 과부하 오류와 retry

현재 네트워크 transient retry와 별도로 ClickHouse의 동시 query 초과 응답을 안전하게 식별한다. ClickHouse error code 202 또는 정규화된 `TOO_MANY_SIMULTANEOUS_QUERIES`일 때만 과부하 오류로 분류한다.

로컬 gate를 통과했는데도 이 오류가 발생하면 다른 프로세스나 운영 query가 server slot을 사용 중인 상태일 수 있다. retry storm을 피하기 위해 짧은 jitter 뒤 한 번만 다시 gate에 진입한다. 두 번째 실패는 typed overload 오류로 상위에 전달한다. SQL 문, query parameter, 사용자 ID는 오류 문자열이나 로그에 포함하지 않는다.

네트워크 오류의 기존 retry 정책은 유지하되, 모든 attempt가 gate slot을 점유한 채 sleep하지 않는다. 실패한 attempt는 slot을 반환하고 backoff 뒤 다시 입장한다. `ensureSchema()`도 retry callback 안에서 실행하되 operation slot을 얻기 전 단계에 둔다.

## 화면 실패 격리

`OverviewTab`은 데이터를 두 등급으로 나눈다.

### 핵심 데이터

`getOrganizationDashboard()` 결과는 overview hero, 비교값, 차트, 순위, provider 분해에 필요하다. 이 호출이 최종 실패하면 기존 dashboard error boundary로 전파한다. 불완전한 핵심 수치를 정상 수치처럼 표시하지 않는다.

### 선택 데이터

도구 활동과 AI 활용 지수는 핵심 묶음과 함께 `Promise.allSettled` 또는 동등한 명시적 처리로 읽는다. 하나가 실패하면 해당 section만 오류/일시 사용 불가 상태를 표시하고 나머지 화면은 렌더링한다. 두 선택 데이터의 실패는 핵심 API 실패로 승격하지 않는다.

기존 10분 활용 지수 캐시는 유지한다. cache miss가 ClickHouse read를 추가하더라도 공통 gate 때문에 프로세스 상한을 넘지 않는다.

## 관측성

최종 실패 시 서버 로그를 한 번 남긴다. 로그에는 다음 안전한 필드만 포함한다.

- `operation`: 예: `organization_dashboard_usage`, `organization_dashboard_breakdown`
- `backend`: `clickhouse`
- `errorClass`: `network`, `overload`, `admission_timeout`, `query`
- ClickHouse numeric error code가 있으면 `errorCode`
- `attempt`, `durationMs`, `queueWaitMs`, `inFlight`

SQL, query parameter, 이메일, 사용자/팀 ID, credential은 기록하지 않는다. retry 중간 실패는 debug 수준 집계에만 반영하고 같은 오류를 매 attempt마다 중복 출력하지 않는다.

운영 검증에서는 ClickHouse `system.query_log` 또는 동등한 query count 측정으로 `/org` 한 번의 핵심 query가 두 개 이하인지 확인한다. 애플리케이션 metric 환경이 이미 있으면 gate의 active, queued, admission timeout count를 연결하고, 없으면 이번 변경에서 새 metrics backend를 도입하지 않는다.

## 테스트

### 결과 계약

- PostgreSQL과 ClickHouse의 새 API가 현재/이전 개요, 시계열, 사용자 순위, 팀 순위, provider 분해를 모두 반환한다.
- `includeTeamLeaderboard=false`이면 팀 집계를 실행하지 않고 빈 배열을 반환한다.
- 새 ClickHouse 묶음 결과가 기존 개별 메서드 결과와 합계, 정렬, 비용 coverage까지 동일하다.
- raw source, 기존 rollup, timezone rollup의 source 선택별 계약 테스트를 유지한다.
- 알 수 없는 `result_kind`나 필수 필드 누락은 조용히 무시하지 않고 query parsing 오류가 된다.

### query 수와 동시성

- cold-cache 관리자 `/org`의 핵심 ClickHouse query 수가 두 개 이하다.
- AI 활용 지수 cache miss와 background insert를 포함해도 gate가 관측한 프로세스 최대 동시 ClickHouse 작업 수는 네 개 이하다.
- fake ClickHouse client가 동시 실행 6 초과를 reject하도록 설정해도 `/org` 회귀 테스트는 성공한다.
- gate는 FIFO 순서를 유지하고 resolve, reject, timeout 모든 경로에서 slot을 반환한다.
- admission timeout 항목을 제거한 뒤 다음 대기 query가 실행된다.
- Code 202는 jitter 후 한 번만 재시도하고, 반복 실패는 typed overload 오류가 된다.

### 화면 실패 격리

- 핵심 묶음 성공 + 도구 활동 실패에서 hero와 chart가 렌더링되고 도구 section만 fallback을 표시한다.
- 핵심 묶음 성공 + 활용 지수 실패에서 나머지 dashboard가 렌더링된다.
- 핵심 묶음 실패는 기존 error boundary로 전달된다.
- 선택 데이터 실패가 unhandled rejection이나 전체 `data-dashboard-error` 상태를 만들지 않는다.

### 회귀 검증

- storage package typecheck와 test
- web typecheck, route/component test, production build
- ClickHouse integration test
- `git diff --check`

## 배포와 운영 검증

DB migration은 없다. 변경 버전의 앱 이미지만 배포하고 ClickHouse 설정의 `max_concurrent_queries_for_user=6`은 유지한다.

배포 전후에 같은 조직/기간/provider 조건으로 다음을 확인한다.

1. `/api/health`와 `/api/ready`가 200이다.
2. 관리자 계정으로 `/org`를 cold cache와 warm cache에서 반복 요청해 전체 화면 오류가 없다.
3. 한 render의 핵심 dashboard ClickHouse query가 두 개 이하이다.
4. gate의 최대 active ClickHouse 작업이 네 개 이하이다.
5. ClickHouse log에 Code 202 또는 `TOO_MANY_SIMULTANEOUS_QUERIES`가 새로 발생하지 않는다.
6. 같은 시간의 outbox flush와 rollup coordinator가 정상 진행한다.
7. 현재 버전과 비교해 overview, 시계열, 순위, provider 합계가 일치한다.

배포 중 예상하지 못한 집계 차이 또는 지연이 나타나면 이전 앱 이미지로 rollback한다. schema와 데이터 변경이 없으므로 별도 DB 복구는 필요하지 않다.

## 구현 순서 경계

구현 계획은 다음 의존성을 지킨다.

1. 결과 계약과 contract test를 먼저 추가한다.
2. ClickHouse 묶음 query parser와 parity test를 만든다.
3. PostgreSQL 및 ClickHouse 저장소 구현을 연결한다.
4. operation gate와 overload 분류를 독립적으로 테스트한 뒤 모든 ClickHouse client 호출에 적용한다.
5. `/org`를 새 API로 전환하고 선택 데이터 실패를 격리한다.
6. query count, 최대 동시성, production build를 검증한다.

세부 구현 중 기존 집계와 새 API의 수치가 다르면 새 수치를 채택하지 않고 차이 원인을 먼저 확인한다.
