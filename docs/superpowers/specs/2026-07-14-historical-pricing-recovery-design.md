# 과거 가격 이력 자동 복구 설계

## 목적

늦게 수집된 과거 사용량에 당시 가격 revision이 없을 때 현재 가격을 임의로 소급하거나 모델별 임시 패치를 추가하지 않는다. toard가 사용 구간의 LiteLLM 가격표 Git 이력을 자동으로 확인하고, 근거가 있는 가격 구간만 원자적으로 등록한 뒤 기존 가격 복구와 rollup 재집계를 이어서 실행한다.

성공 기준은 다음과 같다.

- 6월 등 과거 데이터가 늦게 들어와도 관리자가 모델이나 가격을 입력하지 않는다.
- 모델별 일회성 migration 없이 모든 모델과 보존 구간에 같은 복구 규칙을 적용한다.
- 사용 시각에 적용 가능한 LiteLLM 가격표 이력이 있을 때만 비용을 확정한다.
- 가격이 구간 중간에 바뀌면 변경 전후 이벤트에 서로 다른 revision을 적용한다.
- 아직 검증하지 않은 미래 구간에 과거 가격을 무기한 적용하지 않는다.
- 가격 이력 전체 확인이 끝나기 전에는 일부 revision을 조회 경로에 노출하지 않는다.
- 원본 이벤트의 토큰, 사용자, 세션, 모델, 호스트는 바꾸지 않고 비용과 가격 provenance만 보정한다.
- 비용 보정 뒤 15분, 시간대별 1시간·1일 rollup을 기존 dirty/coverage 규칙으로 자동 재집계한다.
- 외부 가격 이력 조회가 실패하거나 제한되면 기존 데이터와 읽기 정합성을 유지하고 자동 재시도한다.
- 수집과 대시보드 요청 경로에서는 외부 네트워크를 호출하지 않는다.

## 현재 문제와 구조적 원인

현재 가격 자동 동기화는 LiteLLM의 최신 JSON을 하루에 한 번 받아 변경 revision을 저장한다. 동기화할 때 모델별 최초 revision을 논리 보존 시작점까지 복사하는 bootstrap도 만든다.

하지만 bootstrap 생성 코드는 가격 동기화 transaction 안에서만 실행된다. 새 버전 배포 전에 그날 동기화가 이미 성공했다면 기동 후 자동 동기화는 같은 조직 날짜를 이유로 건너뛴다. 후속 migration이 가격 복구 worker만 깨워도 과거 revision 자체가 없으므로 worker는 해당 이벤트를 `waiting_for_catalog`로 남긴다.

더 큰 문제는 bootstrap 정책이 가장 오래된 현재 저장 가격을 과거 전체에 적용한다는 점이다. 모델 가격이 과거에 변경됐다면 비용 정합성을 보장할 수 없다. 7월 7일 `claude-opus-4-8` 40건만 고정 migration으로 해결해도 6월 데이터나 다른 모델에서 같은 문제가 반복된다.

2026-07-14 운영 PostgreSQL을 읽기 전용으로 확인한 결과 현재 인스턴스의 `pricing_revisions`에는 `source = 'litellm-bootstrap'` 행이 0개다. 따라서 현재 운영에서 이미 bootstrap으로 확정한 이벤트를 되돌릴 필요는 없다. 다만 다음 일별 sync가 실행되면 현 코드가 추정 bootstrap을 만들 수 있으므로 이번 변경에서 해당 생성 경로를 제거해야 한다.

## 선택한 접근법

### 채택: 비동기 Git 이력 복구와 staged promotion

가격 revision이 없어 계산하지 못한 과거 모델과 사용 구간을 durable 작업으로 만든다. worker는 LiteLLM 가격 파일의 Git commit 이력을 조회하고, 대상 구간 직전 snapshot과 구간 안의 변경 snapshot을 시간순으로 확인한다.

확인 중인 가격 후보는 staging table에만 저장한다. 전체 구간을 확인한 뒤 하나의 PostgreSQL transaction에서만 canonical `pricing_revisions`로 승격한다. 같은 transaction에서 가격 cache version과 기존 가격 복구 generation을 갱신한다.

승격 뒤 기존 `pricing_repair`가 `unpriced` 이벤트만 재계산하고, 영향받은 15분 bucket을 dirty 처리한다. 기존 coordinator가 15분과 시간대별 1시간·1일 rollup을 다시 만들고 정합성 검증을 통과한 구간만 읽는다.

### 제외한 접근법

1. **모델별 고정 migration**: 현재 40건은 빨리 없어지지만 새 모델과 다른 과거 날짜마다 코드 배포가 필요하므로 제외한다.
2. **최초 관측 가격을 보존 시작점까지 무제한 소급**: 빠르지만 가격 변경 전후를 구분하지 못해 날짜 정합성이 깨지므로 과거 자동 복구의 최종 수단으로 사용하지 않는다.
3. **수집 요청 중 GitHub 조회**: 외부 장애와 rate limit이 수집 지연 및 유실 위험으로 이어지므로 제외한다.
4. **가격 후보를 확인 즉시 canonical revision으로 저장**: 뒤쪽 commit에서 가격 변경이 발견되기 전에 이벤트가 잘못 확정될 수 있으므로 제외한다.

## 기존 bootstrap 정책 폐기

`runPricingSyncTransaction`에서 `ensureBootstrapPricingRevisions` 호출을 제거한다. 최신 가격표 sync는 앞으로 실제로 관측한 조직 날짜 revision만 만들고, 그보다 과거인 이벤트는 historical job이 source 이력을 확인한다.

기존 self-host 설치에 이미 `source = 'litellm-bootstrap'` revision이 있을 수 있으므로 additive migration에 `authoritative BOOLEAN NOT NULL DEFAULT TRUE`를 추가하고 해당 source만 `FALSE`로 표시한다. canonical schedule은 authoritative revision만 신규 계산에 사용한다. 따라서 기존 bootstrap이 새로 수집된 과거 이벤트에 무기한 적용되지 않는다.

이미 bootstrap revision으로 저장된 이벤트는 삭제하거나 즉시 0원으로 되돌리지 않는다. historical job이 동일 모델과 사용 구간의 근거 revision을 승격한 뒤, 기존 repair worker가 다음 두 범위만 재계산할 수 있게 확장한다.

```text
cost_status = 'unpriced'
OR pricing_revision_id IN (authoritative = FALSE인 revision ID)
```

근거 가격을 찾은 이벤트만 authoritative revision으로 교체한다. 이 조건 밖의 정상 `priced`·`legacy` 이벤트는 그대로 보존한다. source history에도 가격이 없으면 기존 bootstrap 비용은 지우지 않고 `추정 가격 근거 확인 대기`로 관리자 상태에 별도 집계한다. 현재 운영에는 해당 이벤트가 없으므로 이 호환 경로가 현재 40건 복구를 지연시키지 않는다.

## 전체 흐름

```text
과거 사용량 수집
  -> 저장된 revision으로 계산 가능: 즉시 priced 저장
  -> 계산 불가: 원본을 unpriced로 안전하게 저장

기존 pricing_repair
  -> 미확정 모델과 최초/마지막 사용 시각 진단
  -> 저장된 revision으로 처리 가능: 기존 비용 복구 실행
  -> 처리 불가한 과거 구간: historical pricing job 생성

historical pricing job (기존 coordinator 부하 슬롯)
  -> 구간 직전 LiteLLM 가격 파일 commit 조회
  -> 구간 안의 가격 파일 commit 목록을 페이지 단위로 조회
  -> 매 tick에서 제한된 snapshot만 내려받아 대상 모델 가격 비교
  -> 가격 구간을 staging table에 저장
  -> 전체 구간 확인 완료
  -> transaction으로 canonical revision 일괄 승격
  -> pricing cache version 갱신 + pricing_repair pending

기존 pricing_repair
  -> unpriced 이벤트 비용과 revision 확정
  -> 15분 bucket dirty

기존 rollup coordinator
  -> 15분 재집계
  -> 시간대별 1시간·1일 재집계
  -> fingerprint 검증
  -> 검증된 coverage만 rollup 읽기
```

## 가격 이력의 시간 규칙

### 검증 구간

historical job은 미확정 이벤트의 `firstAt`이 포함된 조직 날짜 시작부터 `lastAt`이 포함된 조직 날짜의 다음 시작까지를 반열린 구간 `[from, to)`로 확장한다. IANA 조직 시간대 resolver를 사용해 DST와 30분·45분 offset을 보존한다.

오늘 날짜의 미확정 이벤트는 historical job으로 보내지 않고 당일 자동 가격 동기화를 먼저 기다린다. 종료된 과거 날짜만 이력 복구 대상으로 삼아 조회 중 구간 끝이 계속 움직이지 않게 한다.

자동 복구 범위는 원본 논리 보존 기간인 최근 90일로 제한한다. 90일 밖의 원본은 현재 worker 계약상 처리하지 않으며, 1년 rollup만 남은 구간은 원본 비용을 안전하게 다시 계산할 근거가 없으므로 별도 재수집 정책 없이는 변경하지 않는다.

### source commit 적용

GitHub `List commits` API에서 `path=model_prices_and_context_window.json`, `since`, `until`, `per_page=100`을 사용한다. 공개 저장소는 인증 없이 조회할 수 있지만 시간당 요청 수가 제한되므로 pagination cursor와 rate-limit 시각을 durable하게 저장한다.

처리 순서는 다음과 같다.

1. `from` 이하의 마지막 파일 commit 한 건을 baseline으로 구한다.
2. baseline부터 `to` 미만까지 파일을 변경한 commit을 모두 수집한다.
3. commit 목록을 실제 commit 시각 기준 오름차순으로 정렬한다.
4. 각 snapshot에서 대상 모델을 기존 alias 규칙으로 찾되 실제로 매칭된 LiteLLM key도 함께 저장한다.
5. 가격이 달라지거나 모델이 추가·삭제된 시각에만 구간 경계를 만든다.

가격 파일 commit 시각은 공급자의 공식 가격 발효 시각이 아니라 LiteLLM에서 그 가격을 관측할 수 있었던 시각이다. 따라서 commit 전 이벤트에 미래 snapshot을 소급하지 않는다. 근거가 없는 구간은 `unpriced`로 유지한다.

### 유효 종료 시각

`pricing_revisions`에 nullable `valid_until`을 추가한다.

- 기존 일별 동기화 revision: `valid_until = NULL`, 다음 revision 전까지 적용한다.
- historical revision: 확인한 가격 구간의 끝을 `valid_until`로 저장한다.
- 모델이 snapshot에서 사라지면 해당 commit 시각에 직전 가격 구간을 닫는다.
- history job의 마지막 가격은 job의 `to`에서 닫는다.

`resolveCostAt`은 다음 조건을 모두 만족하는 최신 revision만 선택한다.

```text
effective_at <= occurred_at
AND (valid_until IS NULL OR occurred_at < valid_until)
```

이 규칙 때문에 6월 1~10일만 확인한 가격이 이후 늦게 들어온 6월 20일 이벤트에 자동으로 잘못 적용되지 않는다. 6월 20일 데이터는 다시 `unpriced`로 저장되고 새로운 이력 job이 해당 구간을 확인한다.

## durable 상태와 staging

### `pricing_history_jobs`

한 번에 하나의 active job을 유지해 외부 요청과 canonical promotion을 단순하게 만든다.

- `id UUID`
- `state`: `pending | listing | fetching | promoting | completed | waiting_source | failed`
- `range_from`, `range_to`
- `models JSONB`: exact event model 목록
- `commit_refs JSONB`: commit SHA와 commit 시각
- `list_page`, `next_commit_index`
- `next_attempt_at`, `rate_limit_reset_at`
- `consecutive_failures`, `last_error`
- `created_at`, `updated_at`, `completed_at`

같은 active 범위에 새 미확정 모델이 발견되면 아직 snapshot fetch 전에는 모델 목록에 합친다. fetch가 시작된 뒤 발견된 모델은 현재 job 완료 후 다음 job으로 처리해 이미 처리한 snapshot을 부분적으로 다시 해석하지 않는다.

### `pricing_history_candidates`

- `job_id`
- `model_id`: 사용 이벤트에 기록된 exact model
- `source_model_id`: snapshot에서 실제 매칭된 LiteLLM key
- `effective_at`, `valid_until`
- 가격 필드 전체
- `source_commit_sha`, `source_committed_at`
- unique `(job_id, model_id, effective_at)`

staging 행은 비용 계산 schedule에 포함하지 않는다. snapshot을 여러 tick에 나눠 처리하거나 프로세스가 재시작돼도 canonical 가격이 부분 노출되지 않는다.

### 원자적 promotion

전체 commit 처리가 끝난 뒤 transaction에서 다음을 실행한다.

1. candidate를 `pricing_revisions`에 idempotent insert한다.
2. `source = 'litellm-git-history'`, `source_ref = commit SHA`, `source_model_id`를 기록한다.
3. 가격 cache version setting을 새 시각으로 갱신한다.
4. `pricing_repair_status`를 새 generation의 `pending`으로 갱신한다.
5. job을 `completed`로 바꾼다.
6. commit한다.

중간 실패는 전부 rollback된다. 재시도 시 unique key와 job 상태로 같은 revision을 중복 생성하지 않는다. commit 뒤 현재 프로세스의 가격 cache도 즉시 무효화하며 다른 replica는 공유 version 변경으로 다음 조회에서 reload한다.

## 가격 계산과 provenance

역사 snapshot은 전체 가격표를 canonical table에 복사하지 않는다. 현재 미확정 이벤트의 exact model에 매칭되는 가격만 저장한다. alias로 매칭된 경우 `model_id`와 `source_model_id`를 모두 남겨 어떤 LiteLLM 항목을 사용했는지 감사할 수 있게 한다.

가격 후보 비교는 input, output, cache read, cache creation, 200k 초과 tier, fast multiplier 전체가 같아야 동일한 가격으로 본다. 값 하나라도 달라지면 새 revision 구간을 만든다.

정상 authoritative revision으로 확정된 `priced` 이벤트와 `legacy` 이벤트는 historical job과 기존 repair worker 모두 변경하지 않는다. 유일한 예외는 provenance가 `authoritative = FALSE`인 과거 bootstrap 추정 이벤트이며, 이 경우에도 source history에서 근거 가격을 찾았을 때만 교체한다. 따라서 정상 확정 비용을 최신 가격으로 재가격하지 않는다.

## 부하와 속도 보호

과거 가격 이력 조회는 기존 `pricing_repair` coordinator 후보 안의 한 단계로 실행한다. 별도 경쟁 timer를 만들지 않는다.

- coordinator 한 tick에 GitHub commit-list 요청 최대 1회
- snapshot 원문 fetch 최대 4개
- 각 HTTP 요청 timeout 10초
- 동시 fetch 금지
- GitHub `x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after` 준수
- 403/429는 실패 폭주 없이 `waiting_source`로 전환
- 네트워크·5xx는 1분부터 최대 1시간까지 지수 backoff
- staging과 cursor는 매 tick 저장해 재시작 뒤 이어서 처리
- 15분·시간대별 rollup과 기존 120초 공정성 규칙 공유

GitHub REST API는 공개 repository를 인증 없이 조회할 수 있지만 비인증 요청은 시간당 60회 제한이다. 기능은 토큰 없이 동작해야 한다. 선택적 read-only token 환경변수를 지원할 수 있으나 필수 설치 조건으로 만들지 않고 로그에 값을 남기지 않는다.

수집 요청은 기존 schedule만 조회한다. 적용 가능한 revision이 없으면 빠르게 `unpriced`로 저장하고 종료한다. 대시보드 조회도 외부 source를 호출하지 않으므로 이력 복구가 p95 요청 시간을 직접 늘리지 않는다.

## 신규 데이터와 작업 경계

history job은 생성 시 `range_to`를 고정한다. 작업 중 신규 데이터가 들어와도 현재 작업 종료가 계속 밀리지 않는다.

- 현재 검증 범위 안의 신규 과거 이벤트: promotion 뒤 기존 repair가 함께 처리한다.
- 검증 범위 밖의 신규 과거 이벤트: `valid_until` 때문에 임의 가격이 적용되지 않고 다음 history job 대상이 된다.
- 오늘 발생한 신규 이벤트: 정상 일별 가격 sync와 현재 revision을 사용한다.
- source에 끝까지 없는 모델: 이벤트를 수정하지 않고 다음 가격 동기화와 이력 재시도 대상으로 남긴다.

## PostgreSQL과 ClickHouse 재계산

historical promotion 자체는 PostgreSQL metadata만 변경한다. 이후 비용 보정은 기존 저장소별 안전 경로를 그대로 사용한다.

PostgreSQL은 `cost_status = 'unpriced'` 또는 non-authoritative bootstrap revision을 참조한 행만 row lock과 `SKIP LOCKED`로 선택한다. 근거 revision으로 계산할 수 있는 행의 비용, revision ID, 상태를 같은 transaction에서 갱신하고 영향받은 local day mart를 다시 만든다.

ClickHouse는 mutation을 사용하지 않는다. 같은 대상 조건으로 먼저 영향받은 15분 bucket을 dirty 처리한 뒤 같은 `dedup_key`의 더 최신 authoritative priced version을 insert한다. `ReplacingMergeTree FINAL`이 canonical event를 선택한다. 실패하면 dirty가 남아 rollup 조회가 raw fallback을 유지하고 같은 generation token으로 재시도한다.

비용 보정 뒤 기존 worker가 다음 순서로 재집계한다.

```text
usage_events FINAL
  -> usage_15m_rollup_v2
  -> usage_hourly_timezone_rollup
  -> usage_daily_timezone_rollup
  -> fingerprint validation
  -> coverage 승인 및 자동 읽기
```

event 수와 모든 token 합계는 보정 전후 동일해야 한다. 의도적으로 달라지는 값은 `cost_usd`, `pricing_revision_id`, `cost_status`뿐이다.

## 관리자와 사용자 화면

관리자가 실행할 버튼은 추가하지 않는다.

관리 화면은 다음 상태만 관측용으로 표시한다.

- `과거 가격 이력 확인 중`: commit 목록 또는 snapshot 처리 중
- `가격 적용 준비 중`: staging 완료 후 promotion 대기
- `자동 비용 복구 중`: canonical revision 승격 후 event repair 중
- `가격 출처 재시도 대기`: GitHub 장애나 rate limit backoff
- `가격 근거 없음`: 확인한 이력 전체에 모델 가격이 없음

기존 `가격표에서 아직 확인되지 않은 모델` 문구는 원인을 과장하므로 `해당 사용 날짜의 가격 이력이 확인되지 않은 모델`로 바꾼다. source commit SHA와 확인 구간은 관리자 API에만 제공하고 일반 사용자 화면에는 노출하지 않는다.

## 실패와 복구

- GitHub API 장애: staging과 cursor를 보존하고 backoff 뒤 재시도한다.
- rate limit: reset 시각 전에는 요청하지 않는다.
- malformed snapshot 또는 0개 가격: 해당 commit 처리를 실패로 기록하고 canonical promotion을 하지 않는다.
- 프로세스 종료: 오래된 running job을 다음 coordinator가 회수한다.
- candidate 저장 실패: 해당 tick만 rollback하고 같은 index부터 재시도한다.
- promotion 실패: canonical revision과 repair generation이 모두 rollback된다.
- promotion 후 event repair 실패: 기존 repair retry가 이어받는다.
- ClickHouse replacement 실패: dirty fallback과 결정론적 insert token을 유지한다.
- rollup mismatch: 기존 자동 fallback을 유지하고 잘못된 rollup을 읽지 않는다.
- source 전체에 모델 없음: 임의 가격을 생성하지 않고 `waiting_source` 상태로 장기 재확인한다.

## 배포와 호환성

1. additive migration으로 `valid_until`, provenance 필드, history job/candidate table을 추가한다.
2. 기존 revision의 `valid_until`은 NULL이므로 현재 계산 결과는 바뀌지 않는다.
3. 앱 배포 후 기존 40건을 포함한 `waiting_for_catalog` 진단이 자동으로 history job을 만든다.
4. source history promotion 뒤 기존 가격 repair와 rollup worker가 자동으로 이어서 처리한다.
5. 배포 중 구버전 앱은 새 staging table을 보지 않고 기존 revision만 읽는다.
6. canonical promotion은 신버전 앱이 준비된 뒤에만 실행되도록 schema 존재와 worker version을 전제로 한다.
7. 롤백 시 새 historical revision은 `pricing_revisions`에 남지만 기존 resolver는 `valid_until`을 모른다. 따라서 롤백 안전성을 위해 historical promotion 시작 전에 최소 실행 버전을 durable setting으로 확인하거나, 롤백 버전도 `valid_until`을 이해하는 호환 release 이후에만 promotion을 활성화한다.
8. 원본 삭제, TTL 활성화, `priced`·`legacy` 재가격은 수행하지 않는다.

## 구현 경계

주요 변경 대상은 다음과 같다.

- `pricing_revisions.valid_until`, `source_ref`, `source_model_id`
- `pricing_revisions.authoritative`와 기존 bootstrap 신규 계산 제외
- historical job/candidate additive migration과 PostgreSQL repository
- GitHub commit-list 및 raw snapshot client
- source key를 함께 반환하는 가격 alias resolver
- historical candidate interval builder와 staged promotion
- 기존 pricing repair state machine의 history 단계
- `resolveCostAt`의 유효 종료 시각 처리
- pricing cache version invalidation
- 관리자 상태 API와 한국어·영어 상태 문구
- PostgreSQL·ClickHouse 복구 및 rollup end-to-end 검증
- 기존 bootstrap revision을 참조한 이벤트의 근거 기반 재계산

범위에서 제외한다.

- 90일 밖 원본의 자동 재수집
- 공급자 공식 청구서와의 정산
- LiteLLM 외 여러 가격 source의 자동 우선순위
- authoritative `priced` 또는 `legacy` 이벤트의 자동 재가격
- 관리자 수동 가격 입력 UI
- GitHub token을 필수 설치 조건으로 만드는 것

## 검증 기준

- 6월 한 달 fixture에서 가격 변경 전후 이벤트가 서로 다른 historical revision과 비용을 갖는다.
- baseline에 모델이 없고 중간 commit에서 추가된 경우 추가 시각 이후 이벤트만 priced가 된다.
- 모델이 snapshot에서 사라지면 `valid_until` 이후 이벤트는 unpriced로 남는다.
- 검증 범위 밖에 늦게 들어온 이벤트가 이전 historical 가격으로 잘못 확정되지 않는다.
- commit pagination, 중복 SHA, 역순 응답을 정렬·중복 제거한다.
- 403/429와 rate-limit reset을 준수하고 재시작 뒤 cursor를 이어간다.
- 일부 candidate만 저장된 상태에서는 canonical schedule과 event 비용이 변하지 않는다.
- promotion transaction 실패 시 revision, cache version, repair generation이 모두 rollback된다.
- 같은 job을 재실행해도 revision과 event 비용이 중복되지 않는다.
- 기존 bootstrap revision은 신규 수집 비용 계산에서 제외되고, 근거 이력이 확보된 bootstrap 이벤트만 재계산된다.
- PostgreSQL과 ClickHouse에서 `unpriced`와 non-authoritative bootstrap만 복구하고 authoritative `priced`·`legacy`는 보존한다.
- 복구 전후 event 수, input/output/cache token, 사용자·세션·모델·호스트 fingerprint가 같다.
- 15분, 시간대별 1시간·1일 rollup 비용이 raw와 일치하고 검증 전에는 fallback을 유지한다.
- 수집 및 대시보드 테스트에서 GitHub client 호출이 0회임을 검증한다.
- 전체 typecheck, unit/integration test, production build, `git diff --check`를 통과한다.

## 근거 자료

- LiteLLM canonical 가격 파일: <https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json>
- GitHub REST commit 목록 API의 `path`, `since`, `until`, `per_page` 계약: <https://docs.github.com/en/rest/commits/commits#list-commits>
- GitHub REST API rate-limit 및 reset header 계약: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
