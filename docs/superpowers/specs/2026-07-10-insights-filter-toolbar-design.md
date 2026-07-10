# 인사이트 필터 툴바 공통화 설계

## 목표

인사이트 화면의 전용 비교 기간·프로바이더·지표 로직은 유지하면서, 필터의 외형과 헤더 배치를 다른 대시보드 화면의 `DashboardFilters`와 통일한다. 인사이트가 베타 기능임을 사이드바 메뉴와 본문 제목 양쪽에 일관되게 표시한다.

## 선택한 접근

공통 레이아웃을 담당하는 `DashboardToolbar`를 분리한다. 이 컴포넌트는 제목, 상태 배지, leading 콘텐츠, 필터 콘텐츠, trailing 콘텐츠, 한 줄/두 줄 배치만 담당한다.

- 기존 `DashboardFilters`는 기간 해석·URL 갱신·직접 선택·timezone 표시 로직을 그대로 유지하고, 최종 레이아웃만 `DashboardToolbar`에 위임한다.
- 인사이트 페이지도 같은 `DashboardToolbar`를 사용하되, 자체 `InsightFilters`를 필터 콘텐츠로 전달한다.
- 인사이트는 조작 항목과 freshness 정보가 많으므로 `splitHeader`를 사용한다. 첫 줄에는 제목과 데이터 기준 정보를, 둘째 줄에는 비교 기간·프로바이더·지표를 표시한다.
- 본문 제목 옆에는 `DashboardToolbar`의 공통 `statusBadge` 인터페이스로 베타 배지를 표시한다.

`DashboardFilters`에 인사이트 프리셋을 직접 주입하는 방식은 사용하지 않는다. 표준 기간의 `parseFilters`와 인사이트의 현재·이전 기간 비교 규칙이 서로 달라 데이터 로직까지 결합되기 때문이다. 전용 CSS만 복제하는 방식도 이후 공통 툴바 변경에서 다시 어긋날 수 있어 사용하지 않는다.

## 시각 규칙

- 비교 기간과 지표 버튼은 다른 화면과 같은 `Button size="sm"`을 사용한다.
- 선택 버튼은 `default`, 미선택 버튼은 `outline` variant를 사용한다.
- 모든 필터 컨트롤의 높이는 32px로 맞춘다.
- 프로바이더 Select는 기존 공통 필터와 동일한 너비·패딩 클래스를 유지한다.
- 필터 줄은 `flex-wrap`과 8px 간격을 사용해 좁은 화면에서도 자연스럽게 줄바꿈한다.
- 현재·이전 기간 범위 패널은 필터 아래에 그대로 유지한다.
- 베타 배지는 기존 `FeatureStatusBadge`의 cyan 스타일과 번역을 재사용한다.

## 컴포넌트 경계

### `DashboardToolbar`

- 대시보드 상단 툴바의 시각적 구조만 책임진다.
- 필터 값이나 URL, 기간 계산을 알지 못한다.
- 기존 `DashboardFilters`의 `titleNode`, `splitHeader`, trailing 정렬 마크업을 옮긴다.

### `DashboardFilters`

- 기존 기간·프로바이더·버킷·직접 선택 동작을 그대로 책임진다.
- `DashboardToolbar`에 조립된 필터 콘텐츠를 전달한다.
- 내 사용량·팀 현황·히스토리·도구 활동 화면의 렌더 결과를 바꾸지 않는다.

### `InsightFilters`

- `period`, `provider`, `metric` URL 파라미터 갱신을 계속 책임진다.
- `SegmentedControl` 대신 공통 Button 시각 문법을 사용한다.
- `최근 7일`, `이번 주`, `이번 달` 비교 프리셋은 그대로 유지한다.

### 인사이트 페이지

- 직접 작성한 header 행 대신 `DashboardToolbar`를 사용한다.
- `nav.badge.beta` 번역을 읽어 `statusBadge={{ status: "beta", label }}`를 전달한다.
- freshness 정보를 toolbar trailing에 전달하고 `splitHeader`를 활성화한다.
- 비교 기간 범위 패널과 아래 콘텐츠는 변경하지 않는다.

### 사이드바 메뉴

- 기존 인사이트 메뉴 항목에 `badge: "beta"`를 지정한다.
- 기존 `SidebarMenuBadge`, `featureStatusBadgeClassName`, `nav.badge.beta`를 그대로 재사용한다.
- 접힌 사이드바, 모바일 메뉴, 활성 메뉴 판정은 변경하지 않는다.

## 변경하지 않는 범위

- 인사이트 기간 계산, 10분 캐시, PostgreSQL·ClickHouse 쿼리
- 기본 지표 토큰, KPI·그래프·구성 변화
- 다른 대시보드 화면의 필터 기능과 URL 규약
- 공통 색상 토큰과 전역 레이아웃

## 테스트와 검증

- `DashboardFilters`가 `DashboardToolbar`를 사용하고 기존 필터 콘텐츠를 전달하는 계약을 검증한다.
- 인사이트가 `DashboardToolbar`의 `splitHeader`를 사용하고 freshness를 trailing으로 전달하는지 검증한다.
- 인사이트 비교 기간·지표가 `Button size="sm"` 및 `default`/`outline` variant를 사용하는지 검증한다.
- 사이드바 인사이트 항목과 본문 툴바가 모두 `beta` 상태를 사용하는지 검증한다.
- 기존 web/core 테스트와 전체 typecheck를 실행한다.
- 실제 브라우저에서 메뉴와 본문 베타 배지, 인사이트와 내 사용량의 버튼 높이·선택 스타일·행 배치를 비교한다.
- 390px viewport에서 필터 줄바꿈과 가로 오버플로 부재를 확인한다.
