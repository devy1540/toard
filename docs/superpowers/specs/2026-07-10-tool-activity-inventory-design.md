# AI 도구 활동·기기 인벤토리 설계

## 배경

toard는 Claude Code·Codex 등의 로컬 로그에서 토큰 사용량을 수집하고, 선택적으로 프롬프트 본문을 수집한다. 현재 대시보드는 토큰·비용·세션·모델·기기 사용량을 보여주지만, 작업 과정에서 어떤 MCP·스킬·플러그인을 활용했는지와 기기별 설치 상태는 보여주지 않는다.

실제 로그에는 Claude의 `tool_use`와 Codex의 `function_call`·`custom_tool_call`이 남는다. Claude는 `Skill` 호출을 명시적으로 기록하지만 Codex는 별도의 스킬 실행 이벤트를 항상 기록하지 않는다. Codex 스킬은 알려진 스킬 루트 아래의 `SKILL.md`를 읽는 도구 호출로만 보수적으로 감지할 수 있다.

이 기능은 토큰·비용을 주 지표로 유지하면서 AI 도구 활동을 부수 정보로 보여준다. 사용자 기기의 CPU·디스크·네트워크 부하를 늘리지 않는 것을 최우선 성공 조건으로 둔다.

## 목표

- 내 사용량 개요에 MCP·스킬·플러그인 활동 요약을 추가한다.
- 상세 화면에서 기간별 활동 이름, 횟수, 결과, 기기, 감지 근거를 확인할 수 있게 한다.
- 설정의 기기 상세에서 설치된 MCP·스킬·플러그인 목록과 마지막 확인 시각을 보여준다.
- 조직 화면에는 개인과 기기를 식별할 수 없는 범주별 집계만 보여준다.
- 기존 shim 수집 주기 안에서 변경된 로그를 한 번만 읽고 파싱한다.
- 호출 인자·도구 출력·프롬프트를 도구 활동 수집 경로로 전송하지 않는다.

## 범위 제외

- MCP 호출 인자, 실행 명령, 파일 경로, 도구 출력의 저장 또는 표시.
- 프롬프트·응답 본문을 분석한 스킬·플러그인 사용 추정.
- Codex의 `SKILL.md` 접근을 실제 실행으로 단정하는 것.
- Bash·Read·Edit·`exec_command` 같은 일반 내장 도구의 사용량 수집.
- 관리자에게 구성원별 상세 도구 이름이나 기기별 설치 목록을 기본 공개하는 기능.
- 서버가 사용자 기기를 실시간으로 원격 조회하는 기능.
- 최초 활성화 이전의 과거 도구 활동 자동 백필.

## 용어와 표시 원칙

- **MCP 호출**: 로그에 MCP 도구 호출이 명시된 활동이다.
- **스킬 활동**: Claude의 명시적 `Skill` 호출과 Codex의 알려진 `SKILL.md` 로드를 합친 상위 표현이다.
- **명시 호출**: 로그가 스킬 실행 자체를 명시한 높은 신뢰도의 활동이다.
- **로드**: Codex가 알려진 스킬 루트의 `SKILL.md`를 읽은 활동이다. 실행 여부는 단정하지 않는다.
- **플러그인 활동**: MCP 또는 스킬 활동을 설치 인벤토리의 소유 플러그인과 안전하게 연결할 수 있을 때 파생한 집계다.
- **설치됨**: 기기 인벤토리에서 관측된 현재 상태다. 기간별 활동과 섞지 않는다.

개요 카드에서는 용어를 늘리지 않도록 `MCP 호출`, `스킬 활동`, `플러그인 활동`만 보여준다. 상세 행에서만 `Claude 명시 호출` 또는 `Codex 로드` 배지를 보여준다. `사용한 스킬`처럼 실제 실행을 단정하는 표현은 쓰지 않는다.

## 사용자 흐름과 화면

### 내 사용량 개요

기존 개요 화면의 토큰·비용·세션·모델·기기 영역은 그대로 유지한다. 하단에 `AI 도구 활동` 카드를 추가한다.

- MCP 호출 횟수.
- 스킬 활동의 고유 항목 수.
- 플러그인 활동의 고유 항목 수.
- 가장 많이 활동한 항목 최대 3개.
- 데이터가 없으면 설치 상태와 무관하게 `이 기간에 확인된 도구 활동이 없습니다`를 보여준다.
- `자세히` 링크는 `/tools`로 이동하며 현재 기간·provider 필터를 유지한다.

요약 숫자는 명시 호출과 로드를 한 숫자로 보여줄 수 있지만 라벨을 `스킬 활동`로 제한한다. 툴팁에는 `Claude 명시 호출과 Codex 스킬 로드를 포함합니다`를 표시한다.

### 개인 도구 활동 상세

`/tools`는 기존 대시보드 레이아웃을 사용하지만 사이드바에 독립 메뉴를 추가하지 않는다. 내 사용량의 요약 카드와 기기 상세에서 진입한다.

- 기존 기간·provider 필터를 재사용한다.
- 상단에 MCP 호출, 스킬 활동, 플러그인 활동, 실패로 명시된 호출을 요약한다.
- 종류별 상위 항목을 이름·횟수·마지막 활동·성공/실패/알 수 없음으로 보여준다.
- 스킬 상세에는 `명시 호출` 또는 `로드` 감지 근거를 표시한다.
- 기기 필터는 본인 소유 기기 라벨만 보여준다.
- 이름을 안전하게 정규화할 수 없는 이벤트는 저장하지 않으며 `기타`로 뭉개지 않는다.

### 기기별 설치 현황

설정의 `내 기기 · 수신 확인` 목록에서 기기 행을 펼치거나 상세 패널을 열어 현재 인벤토리를 보여준다.

- 플러그인·스킬·MCP별 설치 개수.
- 항목 이름, 활성 여부, 확인 가능한 경우에만 버전과 소유 플러그인.
- 마지막 동기화 시각과 `최신`, `지연`, `아직 수신되지 않음` 상태.
- URL, 서버 실행 명령, 환경 변수, 로컬 절대 경로는 표시하거나 저장하지 않는다.
- 인벤토리와 기간별 활동은 별도 섹션으로 분리한다.

### 조직 화면

조직 화면에는 선택 기간의 범주별 총활동량, 활성 사용자 수, 활성 기기 수, 실패율만 표시한다.

- 사용자 이름, 이메일, 세션 ID, 기기 라벨, 상세 항목 이름을 응답에 포함하지 않는다.
- 사용자가 1명뿐인 작은 집단도 상세 이름을 역추적할 수 없도록 범주 수준 집계만 제공한다.
- 관리자 상세 인벤토리 공유는 후속 조직 설정 기능으로 남기며 기본값은 비공개다.

## shim 수집 아키텍처

### 단일 로그 파싱

현재 어댑터의 사용량·본문 파서를 `ParsedLog` 결과로 통합한다.

```text
변경된 로그 파일 1회 읽기·JSON 파싱
  ├─ usage events
  ├─ prompt records (본문 수집 opt-in일 때만 유지)
  └─ tool activity candidates
```

도구 후보는 로컬 allowlist 분류기를 통과한 뒤에만 wire 객체가 된다. 분류기는 다음 정보만 남긴다.

- 정규화된 MCP·스킬 식별자.
- provider, session ID, timestamp, host.
- 원본 호출 ID의 해시 기반 dedup key.
- 로그가 명시한 경우의 결과 상태.
- `explicit` 또는 `derived_load` 감지 방식.
- 인벤토리로 확인 가능한 경우의 소유 플러그인 식별자.

도구 호출 인자와 출력은 wire 객체에 필드 자체를 만들지 않는다. Codex 스킬 감지는 로컬에서 호출 인자 중 알려진 스킬 루트 아래의 정확한 `SKILL.md` 경로만 검사하고, 정규화된 스킬 식별자를 만든 직후 원본 인자를 폐기한다.

### provider별 활동 감지

- Claude
  - `tool_use.name`이 `mcp__...` 규칙과 일치하면 MCP 활동으로 기록한다.
  - `tool_use.name = Skill`이면 입력에서 allowlist된 스킬 식별자 하나만 로컬 추출하고 `explicit`로 기록한다.
  - 대응하는 `tool_result.is_error`가 있을 때만 성공·실패를 확정하며, 없으면 `unknown`이다.
- Codex
  - `function_call`·`custom_tool_call` 이름이 MCP·플러그인 도구 규칙 또는 로컬 provenance map과 일치하면 활동으로 기록한다.
  - 알려진 스킬 루트의 `SKILL.md`를 읽는 호출은 `derived_load`로 기록한다.
  - 구조화된 `status`가 있는 호출만 결과를 확정하고, 출력 문자열을 분석해 성공·실패를 추정하지 않는다.

일반 내장 도구는 저장량과 사용자 부하를 줄이기 위해 v1에서 무시한다.

### 최초 활성화와 커서

- 새 shim이 처음 도구 수집을 활성화할 때 현재 시각을 `tool-since`로 기록한다.
- 최초 실행은 기존 파일 목록과 stamp를 도구 커서의 기준선으로만 저장하고 과거 파일을 파싱·전송하지 않는다.
- 이후 변경된 파일에서 `tool-since` 이후 활동만 전송한다.
- 사용량, 본문, 도구 활동은 전송 성공 여부가 서로 영향을 주지 않도록 논리적으로 독립된 진행 상태를 갖는다.
- 도구 API 실패 시에도 기존 토큰·비용 커서는 정상 갱신한다.

### 인벤토리 수집

provider별 인벤토리 어댑터가 로컬 설정과 설치 루트를 읽는다. parser는 allowlist 필드만 추출한다.

- 종류: `mcp`, `skill`, `plugin`.
- 정규화된 이름과 display name.
- 활성·비활성 상태.
- 확인 가능한 경우의 버전과 소유 플러그인.
- source provider.

서버 URL, 실행 명령, 환경 변수, 토큰, 로컬 절대 경로는 추출하지 않는다.

- 매 수집 주기에는 설정 파일과 루트 디렉터리의 stamp만 확인한다.
- stamp가 변했을 때만 전체 인벤토리를 다시 계산한다.
- 파일시스템 특성으로 변경 감지를 놓치는 경우를 보완하기 위해 24시간에 한 번만 전체 확인한다.
- 정렬된 안전 필드로 fingerprint를 계산하고 이전 값과 같으면 전송하지 않는다.
- shim 설치·업데이트 직후에는 한 번 즉시 확인한다.

## wire 계약과 API

### 활동 이벤트

`POST /api/v1/tool-events`는 다음 allowlist 필드의 배열만 받는다.

```ts
type ToolActivityWire = {
  dedupKey: string;
  providerKey: string;
  sessionId: string | null;
  host: string | null;
  ts: string;
  activityKind: "mcp" | "skill";
  itemKey: string;
  displayName: string;
  pluginKey: string | null;
  outcome: "success" | "failure" | "unknown";
  detection: "explicit" | "derived_load";
};
```

서버는 ingest token 인증 결과의 `userId`와 `tokenId`를 강제로 덮어쓴다. 클라이언트가 사용자·기기 소유권을 지정할 수 없다. 빈 배열은 shim이 요청하지 않는다.

### 인벤토리 스냅샷

`PUT /api/v1/tool-inventory`는 현재 기기의 전체 스냅샷을 받는다.

```ts
type ToolInventoryWire = {
  host: string | null;
  fingerprint: string;
  observedAt: string;
  items: Array<{
    kind: "mcp" | "skill" | "plugin";
    itemKey: string;
    displayName: string;
    sourceProvider: string;
    pluginKey: string | null;
    version: string | null;
    enabled: boolean;
  }>;
};
```

서버는 인증된 `tokenId`와 host 조합을 기기 소유권으로 사용한다. 동일 fingerprint면 `unchanged`로 응답하고 저장을 건드리지 않는다. 새 스냅샷은 트랜잭션으로 전체 교체해 부분 상태가 보이지 않게 한다.

## 서버 데이터 모델

도구 메타데이터는 낮은 볼륨이고 사용자·기기 소유권 조회가 중요하므로 ClickHouse가 아니라 항상 Postgres에 저장한다.

### `tool_activity_events`

- `id`, `dedup_key UNIQUE`.
- `provider_key`, `user_id`, `ingest_token_id`.
- `session_id`, `host`, `ts`.
- `activity_kind`, `item_key`, `display_name`, `plugin_key`.
- `outcome`, `detection`.
- 사용자·기간·종류와 조직 익명 집계를 위한 인덱스.

`item_key`, `display_name`, `plugin_key`는 길이와 문자 allowlist를 적용한다. 원본 payload를 보존하는 JSONB·TEXT 컬럼은 만들지 않는다.

### `device_tool_inventory_snapshots`

- `id`, `user_id`, `ingest_token_id`, `host`.
- `fingerprint`, `observed_at`, `received_at`.
- 기기별 최신 스냅샷 unique key.

### `device_tool_inventory_items`

- `snapshot_id` 외래 키.
- `kind`, `item_key`, `display_name`, `source_provider`.
- `plugin_key`, `version`, `enabled`.
- snapshot 안에서 `kind + item_key + source_provider` unique.

활동과 인벤토리 저장은 기존 가변 usage storage 계약에 넣지 않고 Postgres 전용 repository로 분리한다.

## 조회와 개인정보 경계

- 개인 조회는 현재 로그인한 `userId`를 서버에서 주입한다.
- 기기 인벤토리는 본인 소유 `ingest_token_id`에 연결된 데이터만 반환한다.
- 조직 조회 repository는 범주별 집계만 반환하는 전용 타입을 사용한다. 개인 조회 row 타입을 재사용하지 않는다.
- 조직 응답에는 항목 이름, user ID, token ID, host, session ID 필드를 만들지 않는다.
- 관리자도 개인 상세 repository를 다른 사용자 ID로 호출할 수 없다.
- 호출 인자·출력·본문을 저장할 컬럼과 wire 필드를 두지 않아 애플리케이션 실수로 노출할 경로를 없앤다.

## 성능 기준

- 새 daemon, watcher, 별도 스케줄러를 만들지 않는다.
- 유휴 수집에서는 기존과 동일하게 로그 본문을 읽지 않고, 새 활동 HTTP 요청을 보내지 않는다.
- 변경된 로그는 사용량·본문·도구 활동을 위해 한 번만 읽고 JSON 파싱한다.
- 인벤토리 무변경 시 전체 설치 디렉터리 탐색과 HTTP 요청을 하지 않는다.
- 대형 fixture benchmark에서 변경 로그 처리 wall time과 CPU time 증가를 기존 대비 각각 10% 이내로 제한한다.
- 동일 fixture 처리 중 최대 메모리는 별도 파일 복사본을 만들지 않아 기존 파서 범위 안에서 유지한다.
- 활동 이벤트는 기존 CHUNK 정책으로 묶고 새 이벤트가 있을 때만 전송한다.
- 서버가 새 endpoint에 `404` 또는 `405`를 반환하면 shim은 해당 기능을 24시간 backoff하고 매 주기 재시도·로그 출력을 하지 않는다.

## 오류 처리와 호환성

- 오래된 shim은 새 endpoint를 호출하지 않으므로 기존 서버와 계속 동작한다.
- 새 shim과 오래된 서버 조합은 endpoint 미지원 backoff 후 기존 사용량 수집만 계속한다.
- 도구 이벤트 전송 실패 시 도구 커서만 유지해 다음 주기에 재시도하고 사용량 커서는 갱신한다.
- 인벤토리 전송 실패 시 서버의 마지막 정상 스냅샷을 유지한다. UI는 마지막 관측 시각으로 `지연` 상태를 표시한다.
- 일부 손상된 JSONL 행은 해당 행만 건너뛰고 나머지 사용량·도구 활동을 계속 처리한다.
- 이름 정규화나 provenance 연결이 불확실하면 추측하지 않는다. MCP·스킬 자체는 확인 가능한 범위에서 기록하되 플러그인 연결은 null로 둔다.
- 구조화된 결과 상태가 없는 Codex 호출은 `unknown`으로 저장한다. 출력 문자열을 분석하지 않는다.

## 설정과 기본값

- 도구 메타데이터 수집은 새 shim에서 기본 활성화하되 로컬 자격 증명 설정으로 끌 수 있게 한다.
- 비활성화하면 활동·인벤토리 수집과 stamp 확인을 모두 건너뛰며 기존 토큰·비용 수집은 유지한다.
- 프롬프트 본문 수집의 기존 opt-in 설정과는 독립적이다.
- 조직 인벤토리 상세 공유는 v1에 넣지 않으며 기본 비공개 상태를 유지한다.

## 테스트와 검증 기준

### shim 단위 테스트

- Claude MCP·Skill fixture에서 이름, 시각, 결과, 호출 ID dedup을 정확히 추출한다.
- Codex MCP 호출과 알려진 `SKILL.md` 접근만 추출하고 일반 명령은 무시한다.
- Codex 스킬은 `derived_load`, Claude Skill은 `explicit`로 구분한다.
- 호출 인자·출력·절대 경로가 wire JSON에 존재하지 않는다.
- 플러그인 provenance가 확실한 항목만 `pluginKey`를 채운다.
- 최초 활성화가 과거 이벤트를 보내지 않고 기준선만 만든다.
- 사용량 전송 성공·도구 전송 실패 시 사용량 커서만 갱신된다.
- 인벤토리 stamp와 fingerprint가 같으면 스캔·전송하지 않는다.
- endpoint 미지원 backoff 동안 추가 요청과 반복 오류 로그가 없다.

### 서버 단위·통합 테스트

- ingest token의 사용자·token ID가 wire 값과 무관하게 서버에서 강제된다.
- 중복 이벤트는 `dedup_key`로 한 번만 저장된다.
- 허용되지 않은 필드, 과도하게 긴 이름, 잘못된 enum과 timestamp를 거부한다.
- 인벤토리 전체 교체가 트랜잭션으로 동작하고 동일 fingerprint는 no-op이다.
- 개인 API가 다른 사용자의 활동·인벤토리를 반환하지 않는다.
- 조직 API 응답 타입과 실제 JSON에 이름·사용자·기기·세션 식별자가 없다.

### UI 테스트

- 내 사용량 카드가 MCP 호출, 스킬 활동, 플러그인 활동을 기간 필터에 맞게 보여준다.
- 상세 화면이 `명시 호출`과 `로드`를 구분하며 `사용한 스킬`이라고 단정하지 않는다.
- 인벤토리가 활동과 별도 섹션에 표시되고 최신·지연·미수신 상태가 구분된다.
- 데이터가 없거나 새 shim이 아직 설치되지 않은 경우 기존 사용량 화면이 깨지지 않고 안내 상태를 보여준다.
- 조직 화면에서 개인 상세 정보가 렌더링되지 않는다.

### 성능 검증

- 현재 parser benchmark를 먼저 기록하고 동일 fixture로 변경 후 wall/CPU 시간을 비교한다.
- 유휴 수집에서 로그 파일 read와 추가 HTTP 요청이 0건인지 계측한다.
- 변경 로그 한 건에서 동일 파일 open/read가 한 번인지 계측한다.
- 인벤토리 무변경 연속 실행에서 전체 walk와 PUT 요청이 발생하지 않는지 검증한다.

## 배포 순서

1. Postgres 마이그레이션과 새 API·조회 UI를 포함한 서버를 먼저 배포한다.
2. 새 endpoint가 준비된 뒤 tool 수집이 포함된 shim을 배포한다.
3. 새 shim은 과거 백필 없이 설치 이후 활동부터 수집한다.
4. 설정의 기기 목록에서 shim 버전과 인벤토리 마지막 수신을 확인한다.
5. 성능 benchmark와 실제 기기 유휴 수집 계측이 기준을 통과한 뒤 기본 활성화를 유지한다.

서버 선배포로 새 shim이 endpoint 미지원 상태를 자주 만나는 일을 줄인다. 배포 순서가 뒤집혀도 24시간 backoff로 기존 사용량 수집에는 영향을 주지 않는다.
