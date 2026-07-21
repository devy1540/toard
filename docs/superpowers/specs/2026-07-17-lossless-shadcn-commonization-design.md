# 무손실 shadcn 공통화 설계

## 목표

현재 `toard` 화면의 색상, 크기, 간격, 테두리, 그림자, 반응형 배치를 바꾸지 않으면서
직접 작성된 UI 기반을 가능한 범위에서 공식 shadcn 컴포넌트로 교체하고, 반복된 제품 UI를
공통 컴포넌트로 이동한다.

## 절대 조건

1. 변경 전후 화면 결과가 같아야 한다.
2. shadcn 공식 `new-york` 컴포넌트를 우선 사용한다.
3. shadcn 기본 스타일 때문에 화면이 달라지면 현재 클래스로 정확히 덮어쓰거나 전환하지 않는다.
4. 제품 고유 UI에 대응하는 shadcn 컴포넌트가 없으면 기존 JSX와 className을 그대로 이동한다.
5. 프로바이더 브랜드색, 차트 데이터색, 상태 색상 의미는 이번 작업에서 재설계하지 않는다.

## 적용 범위

### Alert

공식 shadcn `Alert`를 추가한다. 가격 경고, 구버전 shim 경고, 초대 링크 성공 영역의 현재
className을 그대로 `Alert`에 전달한다. `Alert`의 기본 grid가 현재 flex/block 구조를 바꾸지
않도록 각 사용처에서 기존 `flex` 또는 `block` 클래스를 유지한다.

### Toggle과 ToggleGroup

공식 shadcn `Toggle`, `ToggleGroup`, `ToggleGroupItem`을 추가한다.

- `SegmentedControl`은 `ToggleGroup type="single"`을 기반으로 다시 구현한다.
- 기존 `gap-0.5`, `h-7`, `rounded-sm`, 선택 시 `bg-muted text-foreground`를 유지한다.
- 브랜드 색상 스와치는 `Toggle`을 사용하되 원형, 크기, hover scale, ring을 그대로 유지한다.
- 기간 필터처럼 줄바꿈하는 독립 버튼 묶음은 연결형 `ButtonGroup`으로 바꾸지 않는다.

### Field

공식 shadcn `Field` 계열을 추가하고 `SettingsRow`의 구조 기반으로 사용한다.

- 기존 관리자 설정 행의 `sm:w-52` flex 레이아웃을 유지한다.
- 사용자 설정에는 `lg:grid-cols-[16rem_minmax(0,1fr)]` 레이아웃을 지원하는 variant를 추가한다.
- 테마, 브랜드, 기본 보기, 시간대, Google 로그인, 비밀번호 행을 `SettingsRow`로 조립한다.

### 제품 전용 지표

조직 화면에 반복된 `SummaryTile`, `SupportingMetric`을 대시보드 공통 컴포넌트로 이동한다.

- `SummaryTile`은 대응하는 shadcn surface가 없으므로 기존 markup과 className을 그대로 쓴다.
- `SupportingMetric`은 현재 카드형 외형을 유지하면서 shadcn `Card`를 내부 surface로 사용한다.
- Hero 전체는 페이지별 의미와 구성이 달라 이번 범위에서 합치지 않는다.

## 제외 범위

- 상태 색상 토큰 재설계
- 타이포그래피, 간격, 카드 위계 변경
- `LinkTabs`를 클라이언트 상태 기반 Tabs로 변경
- Markdown 및 운영 상태용 특수 테이블을 shadcn Table로 강제 변경
- hidden peer checkbox를 shadcn Checkbox로 변경
- 연결형 외형이 아닌 버튼 묶음을 `ButtonGroup`으로 강제 변경

## 검증

1. 새 공통화 계약 테스트를 먼저 실패시킨다.
2. 전체 웹 테스트와 TypeScript 타입체크를 실행한다.
3. 격리 PostgreSQL에 대시보드 demo fixture를 넣고 같은 Chromium 환경에서 변경 전후 화면을 캡처한다.
4. `/`, `/insights`, `/org`, `/org/team`, `/org/teams`, `/settings`, `/admin`을 데스크톱과 모바일,
   라이트와 다크에서 비교한다.
5. 차이가 확인되면 해당 변경을 조정하거나 제외한다.
