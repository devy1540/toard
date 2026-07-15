# AI 활용 지수 설계

## 배경

toard는 현재 세션, 모델, 토큰, 비용, host와 MCP·스킬 성공·실패를 수집한다. Cursor의 Tab 수락처럼 사용자가 AI를 얼마나 유용하게 활용했는지 한눈에 이해할 지표가 필요하지만, 현재 데이터에는 코드 수락, 테스트 통과, PR 완료 같은 결과 신호가 없다.

따라서 첫 버전은 생산성이나 업무 품질을 추정하지 않고 현재 수집 가능한 메타데이터에서 컨텍스트 연속성, 실행 안정성, 복구 부담을 계산한다. 점수는 다른 사용자와 비교하지 않고 본인의 과거 기준선과 비교한다.

상위 규범은 [AI 활용 지수 정책](../../ai-utilization-policy.md), 정확한 산식은 [AI 활용 지수 방법론](../../ai-utilization-methodology.md)을 따른다.

## 목표

- 개인 인사이트 화면에 본인 전용 `AI 활용 지수 Beta`를 추가한다.
- 50점을 본인의 직전 28일 기준선 중앙값으로 하는 0~100 상대 점수를 제공한다.
- 컨텍스트 연속성, 실행 안정성, 복구 부담을 독립적으로 계산한다.
- 데이터가 부족하거나 provider가 지원하지 않는 축은 0점이 아니라 계산 불가로 표시한다.
- 조직 화면에는 활성 사용자 5명 이상일 때만 익명 집계를 제공한다.
- 프롬프트·응답·코드 본문과 콘텐츠 수집 상태를 읽지 않는다.
- PostgreSQL과 ClickHouse 사용량 백엔드가 같은 계산 입력 계약을 제공한다.

## 범위 제외

- 코드 수락률, 테스트 성공률, PR 처리 시간 등 새 결과 신호 수집
- LLM이 점수를 계산하거나 수정하는 기능
- 개인별 조직 순위, 관리자 개인 조회, 개인 CSV 내보내기
- 방법론 편집 UI와 사용자별 가중치 설정
- 점수 알림, 목표 점수, 배지, 경쟁 기능
- 프롬프트 본문 또는 E2EE 히스토리 분석
- 장기 점수 스냅샷 테이블

## 승인된 제품 정책

- 개인 지수는 본인만 열람한다.
- 조직에는 익명 집계만 제공한다.
- 조직 집계는 활성 사용자 5명 미만이면 서버에서 억제한다.
- 본문과 코드 내용은 계산에서 제외한다.
- 지수는 코칭용이며 인사평가·보상·징계·순위에 사용할 수 없다.

## 화면

### 개인 인사이트

기존 `/insights` 화면의 기간별 사용량 인사이트와 분리된 `AI 활용 지수 Beta` 섹션을 상단 요약 다음에 배치한다. 일반 인사이트 필터와 무관하게 최근 완료 7일과 직전 28일을 사용하며, 카드 안에 기간을 명시한다.

구성:

1. 종합점수
   - 점수 또는 `계산할 데이터가 부족합니다`.
   - `50 = 본인의 직전 28일 평소 수준` 안내.
   - 방법론 버전과 신뢰도.
2. 세부 축 3개
   - 점수, 원시 비율, 기준선 중앙값.
   - 계산 불가 시 이유.
3. 중립 관측값
   - 활성일, 세션, 도구 사용 세션 비율, 사용한 도구 종류.
   - 우열 색상이나 점수 기여 표시 없음.
4. 데이터 범위
   - 현재·기준 기간, 계산 시각, 지원 provider, 제외된 축.

개인 화면은 `좋음`, `나쁨`, `상위`, `하위`를 사용하지 않는다. 45~55는 `본인의 평소 범위`, 그 밖은 `평소보다 높음/낮음`으로 설명한다.

### 조직 현황

기존 `/org`에 `AI 활용 지수` 익명 집계 카드를 추가한다.

- 표본 충족: 중앙값, 25~75% 범위, 축별 중앙값, 개인 기준선 대비 높음·평소 범위·낮음 비율.
- 표본 미달: 숫자를 렌더링하지 않고 `활성 사용자 5명 이상일 때 표시됩니다`.
- 개인 행, 사용자 이름, 이메일, 순위 링크, 드릴다운을 제공하지 않는다.
- 기존 비용·토큰 순위와 시각적으로 분리하고 설명 문구에 비교 금지를 명시한다.

## 코어 모델

`packages/core/src/utilization.ts`에 저장소와 UI가 공유하는 순수 타입·계산 함수를 둔다.

```ts
export type UtilizationReason =
  | "insufficient_current_days"
  | "insufficient_current_sessions"
  | "insufficient_baseline_days"
  | "unsupported_cache_signal"
  | "insufficient_context_days"
  | "insufficient_known_tool_calls"
  | "low_tool_outcome_coverage"
  | "insufficient_session_tool_calls"
  | "insufficient_valid_dimensions"
  | "suppressed_small_cohort";

export interface UtilizationDailyFeature {
  userId: string;
  day: string;
  active: boolean;
  sessions: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheSignalEvents: number;
  cacheUnsupportedEvents: number;
  toolSuccesses: number;
  toolFailures: number;
  toolUnknown: number;
  repeatedToolFailures: number;
  sessionToolKnownCalls: number;
  toolActiveSessions: number;
  distinctTools: number;
}

export interface UtilizationDimensionResult {
  key: "context_continuity" | "execution_stability" | "recovery_burden";
  score: number | null;
  currentValue: number | null;
  baselineMedian: number | null;
  reason: UtilizationReason | null;
}

export interface PersonalUtilizationResult {
  methodologyVersion: "utilization-v1";
  score: number | null;
  confidence: "high" | "medium" | "low";
  currentPeriod: { from: Date; to: Date };
  baselinePeriod: { from: Date; to: Date };
  dimensions: UtilizationDimensionResult[];
  reasons: UtilizationReason[];
  observations: {
    activeDays: number;
    sessions: number;
    toolActiveSessionRate: number | null;
    distinctTools: number;
  };
}
```

계산 함수는 DB, 번역, React를 알지 않는 순수 함수다.

```ts
calculatePersonalUtilization(
  rows: UtilizationDailyFeature[],
  periods: UtilizationPeriods,
): PersonalUtilizationResult

aggregateOrganizationUtilization(
  results: PersonalUtilizationResult[],
): OrganizationUtilizationResult
```

## provider capability

`packages/core`에 provider/adapter별 활용 지수 capability를 명시한다. 문자열 provider 이름을 산식 안에서 직접 분기하지 않는다.

```ts
interface UtilizationProviderCapability {
  reportsCacheRead: boolean;
  reportsToolOutcome: boolean;
  reportsSessionId: boolean;
}
```

첫 구현은 현재 parser fixture로 cache와 tool outcome 지원 여부를 검증한 뒤 명시적인 표를 작성한다. 확인되지 않은 provider는 보수적으로 `false`다.

## 저장소 계약

사용량 데이터는 PostgreSQL 또는 ClickHouse에 있을 수 있고 도구 이벤트는 PostgreSQL에 있다. UI에서 저장소별 SQL을 알지 않도록 사용량 일별 집계를 `StorageBackend` 계약으로 추가한다.

```ts
interface UtilizationUsageDay {
  userId: string;
  day: string;
  sessions: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheSignalEvents: number;
  cacheUnsupportedEvents: number;
}

getUserUtilizationUsage(
  userId: string,
  query: UtilizationRangeQuery,
): Promise<UtilizationUsageDay[]>;

getOrganizationUtilizationUsage(
  query: UtilizationRangeQuery,
): Promise<UtilizationUsageDay[]>;
```

- 두 메서드는 조직 타임존의 일 경계를 사용한다.
- 현재 7일과 기준 28일을 한 연속 범위로 조회한다.
- PostgreSQL과 ClickHouse는 동일 fixture에서 같은 행을 반환해야 한다.
- ClickHouse는 활성화된 정확한 source 선택 정책을 재사용하고 raw/rollup 중복을 만들지 않는다.

도구 일별 집계는 `apps/web/lib/tool-metadata.ts`에 batch query를 추가한다. SQL window function으로 사용자·세션·도구별 직전 결과와 시각을 비교해 30분 이내 반복 실패를 계산한다. 개인과 조직 조회가 같은 query builder와 row mapper를 사용한다.

## 조합 서비스

`apps/web/lib/ai-utilization.ts`가 다음 책임만 가진다.

1. 조직 타임존 기준 현재·기준 기간 계산.
2. storage의 사용량 일별 행과 PostgreSQL 도구 일별 행 조회.
3. 날짜·사용자 키로 일별 feature 병합.
4. core 순수 함수 호출.
5. 개인 결과 또는 익명 조직 결과 반환.
6. 방법론 버전을 포함한 짧은 결과 캐시.

개인 함수는 서버 세션의 사용자 ID를 인자로 강제한다. 조직 함수는 내부적으로 개인 결과를 계산할 수 있지만 표본 억제 후 `OrganizationUtilizationResult`만 반환하고 개인 배열을 외부로 노출하지 않는다.

## 캐시

- TTL: 10분
- 개인 키: user ID, 현재·기준 기간, 조직 타임존, 방법론 버전
- 조직 키: 조직 범위, 기간, 타임존, 방법론 버전
- 개인·조직 캐시 분리
- 실패, 표본 미달의 이전 성공 값, 부분 계산 예외는 성공 값으로 캐시하지 않음
- 원본 정정 후 명시적 무효화가 없는 첫 버전에서는 최대 10분 지연을 화면에 표시

## 개인정보 경계

- `prompt_records`를 조회하지 않는다.
- 콘텐츠 수집 환경 변수와 E2EE 상태를 읽지 않는다.
- 조직 UI props와 RSC payload에 개인 결과를 포함하지 않는다.
- 표본 미달은 DB 조회 후 렌더링에서 숨기는 방식이 아니라 서비스 반환 전에 억제한다.
- 조직 결과에는 사용자 ID, 이메일, 이름, 개인 점수를 포함하지 않는다.

## 오류와 결측 처리

- 사용량 또는 도구 조회 실패: 오류 경계로 전달하고 0점 결과를 만들지 않는다.
- 일부 provider 미지원: 관련 축에서 제외하고 reason과 지원 범위를 표시.
- unknown outcome 과다: 도구 축 계산 불가.
- 기준선 부족: 모든 축 원시 현재 값은 보여줄 수 있지만 점수는 계산하지 않음.
- 두 축 미만: 종합점수 없음.
- 조직 5명 미만: `suppressed`만 반환.
- 서로 다른 방법론 버전: 조직 집계 거부.

## 테스트

### 코어 산식

- median, MAD, 최소 스케일, 방향 반전, clamp, 반올림.
- 50점 기준선, 5%p 작은 변화, 이상치 영향 제한.
- 축별 최소 조건과 reason.
- 유효 축 1개/2개/3개의 종합점수.
- 낮음·보통·높음 신뢰도.
- 중립 관측값이 점수에 영향을 주지 않음.

### 저장소

- 조직 타임존 일 경계와 DST.
- PostgreSQL/ClickHouse 동일 fixture 결과.
- 현재·기준 범위가 겹치지 않고 부분 일을 제외.
- provider capability에 따른 지원·미지원 이벤트 분리.
- 도구 unknown coverage와 동일 세션·도구 30분 반복 실패.
- 세션 ID 없는 이벤트가 반복 실패에서 제외됨.

### 개인정보

- 다른 사용자 ID로 개인 결과를 요청할 수 없음.
- 관리자도 개인 지수 목록을 받을 수 없음.
- 4명은 suppressed, 5명은 집계.
- 필터 후 5명 미만이면 suppressed.
- 조직 반환형과 렌더 props에 user ID·이메일·개인 점수가 없음.
- 콘텐츠 수집 on/off fixture가 같은 결과를 만듦.

### UI

- 점수, 50 기준 안내, 방법론 버전, 신뢰도, 기간 표시.
- 축별 계산 가능/불가 상태와 번역된 이유.
- 데이터 부족을 0점으로 표시하지 않음.
- 개인 평가·순위 표현이 없음.
- 조직 표본 부족 상태에 숫자·차트가 없음.
- 한국어·영어, 데스크톱·좁은 폭에서 정보 계층 확인.

### 완료 검증

- `pnpm -r typecheck`
- `pnpm -r test`
- PostgreSQL storage integration test
- ClickHouse raw/rollup 동등성 fixture
- `git diff --check`
- 로컬 앱에서 `/insights`, `/org` 실제 화면 확인
- 개인 권한과 조직 4명/5명 경계 확인
- 정책 출시 전 체크리스트 검토
