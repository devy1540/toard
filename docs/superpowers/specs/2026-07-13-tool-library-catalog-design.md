# 도구 라이브러리 카탈로그 설계

## 배경

toard는 현재 shim이 사용자 기기의 MCP·스킬·플러그인 이름, 버전, 활성 상태를 수집하고 설정 화면에서 인벤토리로 보여준다. 서버는 실제 스킬 파일, MCP 실행 설정, 설치 패키지를 보관하거나 배포하지 않는다.

새 기능은 공개된 도구와 워크스페이스 구성원이 공유한 도구를 한곳에서 발견하고, 원본·권한·설치 상태를 비교할 수 있게 한다. 게시 자체는 관리자 승인을 요구하지 않는다. 관리자는 게시된 항목을 검증 상태로 승격하거나 문제 항목을 차단한다.

## 목표

- 워크스페이스 사이드바에 `도구 라이브러리`를 추가한다.
- 공개 카탈로그, 워크스페이스 공유, 내가 공유한 도구를 한 목록에서 탐색한다.
- 이름·설명 검색과 MCP·스킬·플러그인 유형 필터를 제공한다.
- 상세 화면에서 원본, 등록 ref, 지원 클라이언트, 필요한 환경변수 이름, 네트워크 접근 대상을 확인한다.
- 모든 로그인 사용자가 Git 원본 기반 도구를 커뮤니티 상태로 즉시 게시할 수 있게 한다.
- 관리자는 항목을 `검증됨`, `사용 중단 예정`, `차단됨` 상태로 관리한다.
- 기존 기기 인벤토리와 카탈로그 항목을 안전한 식별자로 연결해 `설치됨` 상태를 표시한다.

## MVP 결정

첫 버전은 **소스 연결형 카탈로그**다.

- 공개 도구는 toard 코드에 포함된 읽기 전용 카탈로그로 제공한다.
- 워크스페이스 도구는 Postgres에 저장한다.
- 커스텀 도구 게시에는 접근 가능한 Git HTTPS URL과 semantic version tag 또는 40자리 commit SHA를 요구한다.
- 상세 화면은 원본 링크와 설치 안내를 제공하지만, 브라우저가 로컬 설정을 직접 수정하지 않는다.
- 기존 인벤토리의 `kind + itemKey + sourceProvider`와 카탈로그의 명시적 식별자를 비교해 설치 여부를 표시한다.

이 범위는 실제 파일 전송이나 자동 설치 없이도 공개·팀 도구를 발견하고 신뢰 정보를 공유하는 사용자 가치를 먼저 검증한다.

## 범위 제외

- 로컬 스킬 폴더, 플러그인 파일, MCP 설정 파일의 서버 업로드.
- zip·바이너리·스크립트 artifact 저장소.
- 서버가 MCP 프로세스를 실행하거나 프록시하는 기능.
- 브라우저에서 임의 shell 명령을 자동 실행하는 기능.
- MCP 토큰, 비밀번호, OAuth credential 등 비밀값 저장.
- shim을 통한 원격 강제 설치·자동 업데이트·삭제.
- 여러 toard 인스턴스가 공유하는 공개 마켓플레이스와 게시자 계정 검증.
- 기존 조직 팀별 게시 범위. MVP 워크스페이스 공유는 로그인한 전체 인스턴스 사용자에게 보인다.

## 정보 구조

### 사이드바

`워크스페이스` 그룹에 `/library` 메뉴를 추가한다. 기존 `/tools` 활동 상세와 이름이 충돌하지 않도록 메뉴 라벨은 `도구 라이브러리`, 활동 화면은 기존 진입 경로와 `AI 도구 활동` 표현을 유지한다.

### 라이브러리 목록 `/library`

상단에는 제목, 설명, `내 도구 공유` 버튼을 둔다.

목록 범위:

- `전체`: 공개 카탈로그와 워크스페이스 항목.
- `공개 도구`: toard 내장 카탈로그.
- `워크스페이스`: 구성원이 게시한 항목.
- `내가 공유함`: 현재 사용자가 게시한 항목.

목록 열:

- 이름과 한 줄 설명.
- 유형: MCP, 스킬, 플러그인.
- 출처: 공개 카탈로그, 워크스페이스 작성자, 검증 상태.
- 내 상태: 미설치, 설치됨, 버전 확인 불가.
- 상세 진입.

검색은 이름·설명을 대상으로 하고, 유형 필터와 함께 URL query parameter로 유지한다. 좁은 화면에서는 이름·출처·상태·상세 버튼만 남기고 나머지는 상세 화면으로 보낸다.

### 상세 `/library/[slug]`

- 이름, 설명, 유형, 신뢰 상태.
- Git 원본 URL과 등록 ref. tag는 원본 저장소에서 이동될 수 있으므로 commit SHA보다 강한 불변성을 보장하지 않는다고 표시한다.
- 지원 클라이언트: Codex, Claude Code.
- 필요한 환경변수 이름 목록. 값 입력란은 만들지 않는다.
- 선언된 네트워크 host 목록.
- 게시자와 게시·수정 시각.
- 현재 기기의 인벤토리 기반 설치 상태.
- 원본 문서 열기와 설치 안내 복사.

공개 카탈로그의 `원본 확인`은 toard가 기록한 source URL과 ref를 의미한다. 제작자의 공식 보증이나 보안 감사를 의미하지 않는다는 설명을 표시한다.

### 공유 `/library/share`

모든 로그인 사용자가 접근한다. 필수 입력:

- 이름, slug, 설명, 유형.
- Git HTTPS URL.
- semantic version tag(예: `v1.2.3`) 또는 40자리 full commit SHA.
- 지원 클라이언트 하나 이상.
- 인벤토리 연결용 `itemKey`와 `sourceProvider`.

선택 입력:

- 필요한 환경변수 이름.
- 네트워크 host.
- 설치 안내와 제거 안내.

게시하면 즉시 `community` 상태로 워크스페이스에 노출된다. 임시 저장은 MVP에 넣지 않는다. 작성자는 자기 항목의 메타데이터를 수정하거나 보관 처리할 수 있다. 검증된 항목을 작성자가 수정하면 `community`로 되돌려 기존 검증이 변경된 내용을 보증하지 않게 한다.

### 관리자 `/admin?tab=library`

관리 탭에 `도구`를 추가한다.

- 커뮤니티 항목을 `verified`로 승격.
- `published`, `deprecated`, `blocked`, `archived` 수명주기 변경.
- 차단 사유 입력과 목록·상세 노출.
- 공개 내장 항목은 읽기 전용으로 표시하고 DB에서 수정하지 않는다.

관리자는 일반 게시를 승인하거나 거부하는 게이트가 아니다. 문제 항목 차단과 워크스페이스 추천 상태 관리만 담당한다.

## 데이터 모델

### 공개 카탈로그

`apps/web/lib/tool-catalog-public.ts`에 `ToolCatalogItem` 배열로 둔다. 초기 항목은 구현 시 공식 원본과 현재 설치 문서를 1차 출처에서 확인한 뒤 추가한다. 각 항목은 고정 slug와 인벤토리 연결 식별자를 갖는다.

공개 항목은 배포된 toard 버전과 함께 변경되며 DB 쓰기 대상이 아니다.

### `tool_catalog_items`

- `id UUID PRIMARY KEY`.
- `slug TEXT UNIQUE NOT NULL`.
- `name`, `description`, `kind`.
- `source_url`, `source_ref`.
- `supported_clients TEXT[]`.
- `required_env TEXT[]`, `network_hosts TEXT[]`.
- `install_notes`, `uninstall_notes`.
- `inventory_item_key`, `inventory_source_provider`.
- `trust_status`: `community | verified`.
- `lifecycle_status`: `published | deprecated | blocked | archived`.
- `status_reason`.
- `owner_user_id REFERENCES users(id)`.
- `created_at`, `updated_at`.

공개 카탈로그와 충돌하지 않도록 DB slug는 공개 slug와도 애플리케이션 계층에서 중복을 거부한다.

## 서버 경계와 권한

- 목록·상세는 로그인 사용자만 조회한다.
- 작성은 현재 로그인한 사용자 ID를 서버에서 강제한다.
- 작성자만 자기 항목을 수정·보관할 수 있다.
- `trust_status`와 차단·사용 중단 상태는 관리자만 변경한다.
- blocked 항목은 기본 목록에서 숨기고 직접 접근 시 차단 사유만 표시한다.
- archived 항목은 작성자와 관리자 화면에서만 조회한다.
- source URL은 HTTPS만 허용한다. 사용자 정보가 포함된 URL과 localhost·사설 네트워크 URL은 거부한다.
- source ref는 semantic version tag 또는 40자리 hexadecimal commit SHA만 허용한다. tag는 불변이라고 간주하지 않는다.
- 환경변수는 `^[A-Z_][A-Z0-9_]*$` 이름만 받고 값 필드는 만들지 않는다.
- network host는 hostname만 받고 URL path·credential을 허용하지 않는다.
- 모든 사용자 문자열은 React 텍스트로만 렌더하고 HTML로 해석하지 않는다.

## 인벤토리 연결

현재 인벤토리는 `kind`, `itemKey`, `sourceProvider`, `version`, `enabled`를 가진다. 카탈로그 목록 조회 시 현재 사용자의 최신 기기 스냅샷을 함께 읽어 다음 규칙으로 상태를 계산한다.

- `kind + inventory_item_key + inventory_source_provider`가 일치하면 설치됨.
- 한 기기라도 일치하면 목록에는 `설치됨`을 표시한다.
- 버전이 둘 다 존재할 때만 동일·상이 여부를 표시한다.
- 버전이 없으면 `설치됨 · 버전 확인 불가`로 표현하고 업데이트 가능을 추측하지 않는다.
- 서버는 카탈로그 때문에 인벤토리 수집 범위를 늘리지 않는다.

## 컴포넌트와 파일 경계

- `packages/core/src/tool-catalog.ts`: 카탈로그 타입, enum, 검증 가능한 순수 헬퍼.
- `apps/web/lib/tool-catalog.ts`: Postgres repository, 공개·워크스페이스 병합, 권한 검사.
- `apps/web/lib/tool-catalog-public.ts`: 내장 공개 항목.
- `apps/web/app/(dashboard)/library/page.tsx`: 목록과 query filter.
- `apps/web/app/(dashboard)/library/[slug]/page.tsx`: 상세.
- `apps/web/app/(dashboard)/library/share/*`: 게시 폼과 server action.
- `apps/web/app/(dashboard)/admin/library-*`: 관리자 검증·상태 관리.
- `messages/{ko,en}/library.json`: 라이브러리 문구.
- `messages/{ko,en}/nav.json`, `messages/{ko,en}/admin.json`: 메뉴·관리 탭 문구.

목록 렌더링, 폼, repository, 검증 규칙을 한 파일에 섞지 않는다.

## 오류 처리

- 중복 slug는 폼 오류로 반환한다.
- 원본 URL·ref·환경변수·hostname 검증 실패는 필드 오류로 반환한다.
- DB 오류는 사용자에게 일반 오류를 보여주고 상세 DB 메시지를 노출하지 않는다.
- 공개 항목과 DB 항목 병합 중 잘못된 공개 정의는 테스트에서 실패시키며 런타임에 조용히 숨기지 않는다.
- 인벤토리 조회 실패는 카탈로그 탐색을 막지 않고 설치 상태를 `확인할 수 없음`으로 표시한다.

## 테스트와 검증

### 단위·repository

- 카탈로그 kind, 신뢰·수명주기 enum, slug, URL, ref, 환경변수, hostname 검증.
- 공개·DB slug 충돌 거부.
- 일반 사용자의 즉시 community 게시.
- 작성자 수정·보관과 타 사용자 거부.
- 검증 항목 수정 시 community 환원.
- 관리자만 검증·차단·사용 중단 가능.
- 인벤토리 일치와 버전 미확인 상태 계산.

### UI

- 전체·공개·워크스페이스·내 항목 범위와 검색·유형 query 유지.
- 목록에서 이름·유형·출처·설치 상태 표시.
- 상세에서 원본·ref·환경변수 이름·네트워크 host 표시.
- 공유 폼의 필드 오류와 게시 후 상세 이동.
- 관리자 도구 탭의 검증·차단 동작.
- 한국어·영어 번역 키 존재.
- 390px에서 가로 오버플로 없이 목록이 축약됨.

### 완료 기준

- migration up/down과 package typecheck 통과.
- web/core 테스트와 `git diff --check` 통과.
- 실제 브라우저에서 일반 사용자 게시 → 목록 노출 → 상세 조회 흐름을 확인.
- 관리자 검증 → 검증 배지 반영, 차단 → 기본 목록 제거를 확인.
- 기존 설정 화면의 기기 인벤토리와 `/tools` 활동 상세가 회귀하지 않음을 확인.

## 후속 단계

- shim에서 `내 기기에서 가져오기`를 시작해 선택한 로컬 파일만 공유 패키지로 만드는 흐름.
- 서버 artifact 저장과 checksum·서명·용량 제한.
- `toard tools install`을 통한 구조화된 로컬 설치·제거.
- 기존 팀 단위 노출, 사용자별 opt-out, 승인된 자동 동기화.
- 외부 공개 registry 연동과 게시자 검증.
