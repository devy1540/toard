# shadcn 날짜 범위 선택기 설계

## 배경

대시보드의 직접 기간 선택은 shadcn `Input` 외형 안에 브라우저 네이티브
`input[type="date"]` 두 개를 넣는다. 입력 테두리는 제품 스타일을 따르지만 달력 팝업은
브라우저가 렌더링하므로 toard의 브랜드 색상, 간격, 다크 모드와 일치하지 않는다.

## 목표

- 두 네이티브 날짜 입력을 하나의 shadcn 날짜 범위 선택기로 교체한다.
- 시작일과 종료일, 선택 중인 범위를 한 달 달력 안에서 시각적으로 보여준다.
- 기존 URL 계약과 서버의 기간 해석을 바꾸지 않는다.
- 한국어와 영어, 키보드 조작, 다크 모드, 좁은 화면을 지원한다.
- 변경을 `v0.15.26` 패치 릴리스로 배포한다.

## 비목표

- 프리셋 기간, provider, bucket 필터의 동작이나 배치를 바꾸지 않는다.
- 서버의 타임존 경계 계산, 최대 조회 범위, 쿼리 계약을 바꾸지 않는다.
- 두 달을 동시에 보여주는 데스크톱 전용 변형을 추가하지 않는다.
- 날짜를 선택하자마자 자동 적용하지 않는다.

## 선택한 접근법

shadcn 공식 Date Picker 조합인 `Popover + Calendar`를 사용하고 `Calendar`는
`react-day-picker`의 `range` 모드로 동작시킨다. 툴바에는 범위 전체를 표시하는 outline
버튼 하나와 기존 `적용` 버튼을 둔다.

한 달 달력은 화면 폭 변화 없이 모바일과 데스크톱에서 같은 조작 모델을 유지한다. 장기
범위는 이전·다음 달 탐색으로 선택한다. 두 달 동시 표시는 장기 범위에 유리하지만 툴바
주변 팝업이 커지고 별도 모바일 분기가 필요하므로 이번 범위에서 제외한다.

## 컴포넌트 구성

### 공통 UI

- `components/ui/calendar.tsx`: shadcn Calendar를 프로젝트의 Button, 색상 토큰,
  Tailwind 설정에 맞춰 설치한다.
- `components/ui/popover.tsx`: shadcn Popover를 설치한다.
- `react-day-picker`: Calendar의 날짜·범위 선택 엔진으로 사용한다.

shadcn CLI가 현재 프로젝트의 `components.json`과 Radix 계열 설정을 읽어 생성한 코드를
기준으로 하며, 생성 뒤 프로젝트 스타일과 필요한 locale 전달 부분만 최소 수정한다.

### 대시보드 범위 선택기

`DashboardFilters` 안의 네이티브 입력 두 개를 다음 구성으로 교체한다.

1. outline 버튼은 달력 아이콘과 현재 초안 범위를 표시한다.
2. 버튼을 누르면 한 달짜리 Popover Calendar가 열린다.
3. 첫 날짜를 선택하면 범위 초안의 시작점이 된다.
4. 두 번째 날짜를 선택하면 시작일과 종료일 사이가 브랜드 색으로 연결된다.
5. 같은 날짜를 시작일과 종료일로 선택하는 하루 범위도 허용한다.
6. 시작일과 종료일이 모두 있을 때만 기존 `적용` 버튼을 활성화한다.
7. `적용`은 기존과 동일하게 `period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`를
   router에 전달한다.

프리셋을 고르면 직접 선택 영역은 기존처럼 닫힌다. 다시 열었을 때는 현재 컴포넌트의
초안 범위를 그대로 보여준다.

## 날짜와 타임존 데이터 흐름

서버 계약은 날짜 키 `YYYY-MM-DD`이며 특정 시각이 아니다. Calendar는 UI 표현을 위해
JavaScript `Date`를 요구하므로 전용 순수 변환 함수를 둔다.

- 날짜 키에서 Calendar 날짜를 만들 때 연·월·일을 분리해 로컬 정오의 `Date`를 만든다.
- Calendar 날짜를 날짜 키로 만들 때 `getFullYear`, `getMonth`, `getDate`를 사용한다.
- `toISOString()`은 UTC 변환으로 날짜가 하루 이동할 수 있으므로 사용하지 않는다.
- URL을 적용한 뒤 기존 서버 코드가 viewer timezone 기준 `[from, to]` 범위를 해석한다.

이 변환은 `Date`를 날짜 전송 포맷이 아닌 달력 셀 식별용 값으로만 사용한다. 따라서
브라우저 timezone과 서버의 viewer timezone이 달라도 URL 날짜 키는 바뀌지 않는다.

## 표시와 locale

- 현재 locale이 `ko`이면 `react-day-picker/locale`의 한국어 locale을 전달한다.
- 그 외에는 영어 locale을 전달한다.
- 버튼 라벨은 기존 `next-intl` locale로 연·월·일을 표시하되, 값이 없거나 범위가
  완성되지 않은 상태를 번역 문자열로 명확히 알린다.
- 좁은 화면에서는 버튼과 `적용` 버튼이 기존 flex-wrap 규칙에 따라 다음 줄로 이동한다.
- Popover는 trigger 시작점에 정렬하고 viewport 너비를 넘지 않게 한다.

## 접근성

- trigger는 실제 `Button`이며 기존 `filters.startDate`와 `filters.endDate` 의미를 합친
  날짜 범위 aria-label을 가진다.
- Calendar의 날짜 셀, 월 이동, 선택 상태는 React DayPicker의 키보드·ARIA 동작을
  유지한다.
- 범위가 완성되지 않으면 `적용`을 비활성화해 불완전한 쿼리를 만들지 않는다.
- 선택 상태는 색상만으로 구분하지 않고 range 시작·끝의 버튼 상태와 접근성 속성을
  함께 유지한다.

## 오류와 경계 상태

- URL에 유효하지 않은 날짜 키가 들어오면 Calendar 초깃값으로 변환하지 않는다.
- 시작일만 선택한 상태에서는 적용할 수 없다.
- 두 번째 선택이 시작일보다 앞이면 range 선택 엔진이 날짜 순서를 정규화한다.
- 같은 날짜 범위는 기존 하루 조회와 동일하게 허용한다.
- 달력을 닫아도 초안은 유지하며 URL은 `적용` 전까지 변경하지 않는다.

## 테스트 전략

TDD 순서로 다음 계약을 먼저 실패시키고 구현한다.

1. 날짜 키와 Calendar 날짜의 양방향 변환, 윤년, 월 경계, DST 인접일을 순수 함수로
   검증한다.
2. 유효하지 않은 날짜 키를 거부하는 동작을 검증한다.
3. 범위가 완성됐을 때만 적용 가능한 상태가 되는 동작을 검증한다.
4. DashboardFilters가 더 이상 네이티브 date input을 렌더링하지 않고 shadcn
   Calendar trigger와 기존 적용 동작을 제공하는지 컴포넌트 테스트로 검증한다.

로컬 완료 게이트는 다음과 같다.

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/web build
pnpm typecheck
pnpm test
git diff --check origin/main...HEAD
```

추가로 실제 브라우저에서 한국어·영어, 라이트·다크, 데스크톱·좁은 폭, 같은 날 범위,
월을 넘는 범위, 적용 후 URL을 확인한다.

## 릴리스

검증된 브랜치를 push하고 PR CI(`pnpm typecheck`, `pnpm test`)가 성공한 뒤 `main`에
merge한다. merge된 commit에 annotated tag `v0.15.26`을 생성해 push한다. 태그가
실행하는 `shim-release`와 `docker-publish`를 모두 성공할 때까지 확인하고, GitHub Release
`v0.15.26` 및 GHCR 멀티아치 이미지 manifest가 게시됐는지 확인한다.

릴리스 게시와 이미 실행 중인 self-hosted 서버 반영은 별개다. 이 작업의 완료 조건은
릴리스 artifact 게시까지이며, 실행 중인 서버는 운영자가 새 태그로 업데이트한 뒤 화면이
바뀐다.

## 성공 기준

- 직접 선택 영역에 네이티브 date input이 없다.
- 단일 shadcn 범위 Calendar에서 시작일·종료일과 중간 범위를 확인할 수 있다.
- 적용 후 기존 custom period URL과 서버 조회 결과가 유지된다.
- locale, 다크 모드, 키보드, 좁은 화면에서 사용할 수 있다.
- 로컬 검증, PR CI, merge, `v0.15.26` tag workflow와 GitHub Release가 모두 성공한다.
