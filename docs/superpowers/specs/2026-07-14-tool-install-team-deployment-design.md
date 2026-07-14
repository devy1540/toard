# 도구 설치·팀 기본 배포 설계

## 배경

현재 `feat/tool-library-catalog` 브랜치는 MCP·스킬·플러그인의 Git 원본, 버전, 필요한 환경변수 이름, 네트워크 접근 대상과 설치 안내를 공유한다. shim이 수집한 기기 인벤토리를 카탈로그와 연결해 설치 여부도 보여준다. 하지만 상세 화면의 설치 동작은 안내 복사에 그치고, 팀이 공통 도구를 배포하거나 자동으로 업데이트할 수는 없다.

이 설계는 기존 카탈로그에 실제 설치 엔진과 팀 기본 배포를 함께 추가한다. Zeude처럼 서버가 모든 파일과 비밀값의 원본이 되는 방식은 택하지 않는다. Git 저장소는 도구 원본, toard 서버는 원하는 상태와 배포 결과, 사용자 기기는 설치 실행과 비밀값의 source of truth가 된다.

## 확정 결정

- 개인 사용자는 라이브러리에서 도구를 직접 설치한다.
- 팀 리더는 관리자 검수 없이 커뮤니티 도구도 팀 기본값으로 지정할 수 있다.
- 팀 기본 도구는 대상 구성원의 지원 기기에 자동 적용된다.
- 구성원은 팀 기본 도구를 개인적으로 제외할 수 있다.
- MCP 비밀값은 사용자 기기에서 입력하고 toard 서버로 보내지 않는다.
- 같은 원본의 새 버전은 자동 업데이트하되 점진 배포와 자동 롤백을 사용한다.
- 권한 확대나 원본 identity 변경은 자동 업데이트하지 않고 팀 리더 또는 개인 사용자의 승인을 요구한다.
- 조직 관리자는 게시·배포 승인자가 아니다. 문제 도구의 사후 차단과 팀 리더 지정만 담당한다.

## 목표

- 카탈로그 상세에서 구조화된 `설치하기` 동작을 제공한다.
- 개인 설치와 팀 기본 배포가 하나의 원하는 상태 계산과 shim 설치 엔진을 사용한다.
- 온라인 기기는 설치 요청 후 90초 안에 설치 완료 또는 명시적인 대기·설정 필요·충돌·실패 상태가 된다.
- 사용자가 직접 만든 Claude Code·Codex 설정은 덮어쓰거나 삭제하지 않는다.
- 공개 Git 저장소와 Workspace GitHub App으로 연결한 비공개 저장소를 지원한다.
- Skill, MCP, Plugin에 종류별로 제한된 설치 manifest를 제공하고 임의 shell script 실행은 허용하지 않는다.
- 새 버전을 canary에서 시작해 50%, 100%로 확대하고 실패 시 직전 정상 버전으로 복구한다.
- 설치, 제외, 업데이트, 충돌, 롤백 상태를 사용자와 팀 리더가 이해할 수 있게 보여준다.

## 범위 제외

- Skill 원본 파일, MCP 비밀값, GitHub installation access token의 서버 영구 저장.
- 사용자가 입력한 임의 shell command를 서버가 그대로 배포하고 실행하는 기능.
- 사용자가 제외할 수 없는 강제 팀 정책.
- 일반 게시에 대한 조직 관리자 사전 승인.
- 조직 간 공개 marketplace, 결제, 게시자 신원 인증.
- 인증 header가 필요한 원격 HTTP MCP를 위해 toard가 로컬 HTTP 프록시를 상시 실행하는 기능. 첫 버전은 클라이언트 native OAuth 또는 별도 수동 설정으로 남긴다.
- Windows native 설치. 기존 shim 지원 범위와 Windows 로드맵을 따른다.

## 핵심 원칙

### 데이터 소유권

- Git 원본: 실제 Skill 파일과 배포 가능한 소스의 원본.
- toard 서버: 버전별 설치 manifest, 정확한 source ref, canonical tree digest, 팀 정책, 개인 선택, rollout 상태와 비밀값이 제거된 결과 보고.
- 사용자 기기: 실제 설치 파일, 클라이언트 설정, 로컬 비밀값, 직전 정상 버전.

비공개 GitHub 저장소는 Workspace GitHub App으로 접근한다. 서버는 설치 시점에 짧은 수명의 provider download URL을 발급하고 GitHub App token을 shim에 노출하지 않는다. provider가 클라이언트에서 사용할 수 있는 짧은 수명의 URL을 제공하지 못하면 해당 원본은 첫 버전에서 자동 배포 대상이 될 수 없다. 서버가 private artifact를 영구 보관하거나 장기 캐시하지 않는다.

### 원하는 상태

기기별 원하는 상태는 다음 우선순위로 계산한다.

1. 사용자가 해당 도구를 `exclude`로 설정하면 설치하지 않는다.
2. 사용자가 해당 기기 또는 모든 기기에 개인 설치를 설정하면 개인 선택 버전을 적용한다.
3. 그 외에는 소속 팀의 기본 정책을 적용한다.
4. 어떤 선택도 없으면 toard가 해당 도구를 관리하지 않는다.

개인 설치가 특정 기기만 대상으로 하면 나머지 기기에는 팀 기본 정책을 계속 적용할 수 있다. 팀 정책이 제거돼도 개인 설치가 남아 있으면 도구를 유지한다.

### 관리 영역

shim은 자신이 설치하고 `managed state`에 기록한 파일과 설정 키만 수정한다. 같은 이름의 MCP·Skill이 이미 존재하지만 toard 관리 기록이 없으면 자동으로 덮어쓰지 않고 `conflict`를 보고한다. 사용자가 `기존 설정 유지` 또는 `toard 관리로 전환`을 선택해야 한다.

## 권한 모델

현재 조직 권한 `users.role = member | admin`과 별도로 `users.team_role = member | leader`를 추가한다. 팀이 없는 사용자의 `team_role`은 `member`로 취급한다. 한 팀에는 여러 leader가 있을 수 있다.

- member: 개인 설치, 특정 기기 선택, 팀 기본 도구 제외, 자기 비밀값 설정.
- leader: member 권한과 자기 팀 기본 정책 추가·제거·업데이트 재개·수동 롤백.
- admin: team leader 지정, 게시 항목의 사후 검증·차단. 일반 설치와 팀 기본 배포에 대한 사전 승인 권한은 사용하지 않는다.

모든 정책 변경, 권한 확대 승인, 롤백과 차단은 actor, 대상 팀·도구·버전, 이전 값과 이후 값, 시각을 감사 로그에 남긴다.

## 사용자 경험

### 개인 설치

1. 사용자가 `/library/[slug]`에서 source identity, 정확한 버전, 지원 클라이언트, 필요한 환경변수 이름, 네트워크 host와 자동 검사 결과를 확인한다.
2. `설치하기`를 누르면 기본적으로 자신의 지원 가능한 모든 연결 기기를 대상으로 한다.
3. 고급 옵션에서 특정 기기만 선택할 수 있다.
4. 서버는 개인 원하는 상태를 저장하고 화면을 `설치 대기`로 바꾼다. 브라우저가 로컬 shell을 직접 실행하지 않는다.
5. 온라인 shim이 manifest를 가져와 staging, digest 검증, 설정 병합, 결과 보고 순으로 적용한다.
6. 비밀값이 필요하면 파일과 비밀값 없는 설정까지만 적용하고 `설정 필요`를 보고한다.
7. 사용자는 `toard-shim tool configure <slug>`를 실행해 masked prompt로 값을 입력한다.
8. 다음 reconcile에서 도구 시작 검증까지 성공하면 `설치됨`이 된다.

manifest 경량 조회는 daemon에서 기본 60초 간격으로 수행하고 ETag가 같으면 body를 받지 않는다. `claude` 또는 `codex` 실행 시에도 사용자 시작을 막지 않는 background reconcile을 요청한다. daemon이 없거나 오프라인이면 `다음 shim 실행 시 적용`이라고 표시한다.

### 팀 기본 배포

1. 팀 리더가 상세 화면에서 `팀 기본으로 추가`를 누른다.
2. 적용 전에 대상 구성원·지원 기기 수, 비밀값이 필요한 예상 사용자 수, 기존 인벤토리 기반 충돌 가능 기기를 보여준다.
3. 팀 리더가 확정하면 현재 정상 버전을 팀 정책에 연결한다.
4. 지원 기기는 다음 manifest 조회에서 자동 적용한다. 오프라인 기기는 대기한다.
5. 구성원에게 도구, 버전, 권한 요구사항, 제외 진입점을 인앱으로 알린다.
6. 구성원이 `팀 기본에서 제외`하면 모든 자기 기기에서 해당 팀 정책을 상속하지 않는다. shim은 toard가 관리하던 설정만 제거한다.

커뮤니티 상태 도구도 팀 기본으로 지정할 수 있다. `verified`는 추천 신호일 뿐 배포 권한의 필수 조건이 아니다. 차단된 도구는 새 설치를 중단하고 관리 중인 설치를 제거 대상으로 전환한다.

### 공유 흐름 개선

기존 전체 필드 입력 폼을 그대로 자동 설치 입력으로 사용하지 않는다.

- `내 기기에서 선택`: shim 인벤토리에서 도구를 고르고 감지된 설치 정보를 확인한다.
- `GitHub에서 가져오기`: 공개 URL 또는 Workspace GitHub App 저장소와 경로를 고른다.

toard가 이름, 유형, 지원 클라이언트, source ref, 설치 manifest 후보와 권한 요구사항을 추출한다. 첫 확인 화면은 이름, 설명, 유형만 보여주고 설치 세부정보는 고급 설정으로 접는다. 자동 추출에 실패한 항목만 종류별 구조화 필드를 요구한다.

### 상태 표현

- `queued`: 기기가 오프라인이거나 아직 manifest를 가져오지 않음.
- `applying`: 다운로드 또는 설정 반영 중.
- `settings_required`: 필요한 로컬 비밀값 또는 client-native 인증이 없음.
- `installed`: 원하는 버전과 실제 관리 버전이 같고 검증이 성공함.
- `conflict`: 기존 비관리 설정과 충돌함.
- `failed`: 적용하지 못했으며 기존 정상 상태를 유지함.
- `rolled_back`: 새 버전 적용에 실패해 직전 정상 버전으로 복구함.
- `excluded`: 사용자가 팀 기본 도구를 제외함.
- `unsupported`: shim 또는 클라이언트가 manifest 종류를 지원하지 않음.

## 설치 manifest

모든 버전은 변경할 수 없는 manifest와 canonical tree digest를 가진다. tag가 가리키는 commit이 바뀌어도 이미 등록된 버전의 digest는 바뀌지 않는다. 수정은 새 버전 추가로만 한다.

공통 필드:

- `schemaVersion`, `catalogItemId`, `versionId`, `kind`.
- source provider, repository identity, URL, exact ref, source path.
- canonical tree digest. 파일의 정렬된 상대 경로와 byte content로 계산하며 archive 자체의 byte digest에 의존하지 않는다.
- 지원 클라이언트와 최소 shim protocol version.
- 환경변수 이름, 네트워크 host, 실행 파일과 구성요소 목록으로 만든 permission fingerprint.
- 종류별 install payload와 관리 키.

종류별 payload:

- Skill: `SKILL.md`를 포함한 허용된 파일 트리와 대상 Claude/Codex skill 경로.
- MCP stdio: shell string이 아닌 `command`, 고정된 `args[]`, `requiredEnvNames[]`, client별 관리 키. package 실행은 정확한 package version을 포함해야 한다.
- MCP remote HTTP: URL과 client-native 인증 방식. custom secret header를 직접 써야 하면 자동 완료하지 않고 `settings_required`로 남긴다.
- Plugin: 고정된 Skill·MCP version ID 목록. 구성요소 전체를 하나의 transaction으로 적용하거나 전체 롤백한다.

manifest는 임의 preinstall·postinstall shell script를 포함할 수 없다. 지원 명령과 경로는 adapter가 구조적으로 생성한다.

## 서버 구성요소

### Catalog version service

Git 원본과 종류별 manifest를 검증하고 immutable version을 만든다. 경로 탈출, symlink, 과도한 파일 수·크기, 누락된 core file, 지원하지 않는 installer를 거부한다. 공개 카탈로그도 배포 시 동일한 version 모델을 사용한다.

### Desired state service

팀 정책, 개인 설치·제외, 기기 대상과 항목 차단 상태를 합쳐 사용자·기기별 원하는 상태를 계산한다. 권한 검사는 service와 repository 양쪽 경계에서 수행한다.

### Manifest API

ingest token과 기기 fingerprint로 인증하고 해당 기기에 필요한 항목만 반환한다. 응답에는 비밀값이 없으며 ETag, schema version과 만료 시간이 포함된다. 차단, 제외, rollout cohort와 shim capability를 반영한다.

### Deployment report API

shim이 적용 상태와 비밀값이 제거된 오류 code를 보낸다. command arguments, environment values, local file content와 GitHub token은 받지 않는다. 같은 rollout·device·version 보고는 멱등 처리한다.

### Rollout coordinator

DB 상태를 기준으로 canary, 확대, 활성화, 중단과 롤백을 전이한다. 여러 app replica에서 한 rollout을 동시에 진행하지 않도록 기존 scheduler lease 패턴을 재사용한다. 프로세스 재시작 뒤에도 DB 상태에서 계속 진행한다.

## 데이터 모델

### `users.team_role`

`member | leader`, 기본 `member`. 기존 조직 role과 독립적이다.

### `tool_catalog_versions`

- catalog item ID, 표시 version.
- source provider·repository identity·URL·exact ref·source path.
- canonical tree digest와 permission fingerprint.
- manifest JSON, manifest schema version, 최소 shim protocol version.
- 생성자와 생성 시각.

version row는 update하지 않는다. 잘못된 버전은 배포 불가 상태로 표시하고 새 version을 만든다.

### `team_tool_policies`

- team ID와 catalog item ID unique.
- 현재 target version, last-known-good version.
- tracking mode `auto | pinned`.
- rollout phase와 cohort seed.
- enabled, 생성·수정자와 시각.

### `user_tool_preferences`

- user ID와 catalog item ID unique.
- mode `install | exclude`.
- install scope `all_devices | selected_devices`.
- 개인 target version과 tracking mode.
- 생성·수정 시각.

선택 기기는 별도 `user_tool_preference_devices` join table로 연결한다. fingerprint 배열을 JSON에 넣지 않는다.

### `tool_deployment_reports`

- user, ingest token, device fingerprint, catalog item, desired version, applied version.
- 상태, 비밀값 없는 error code, attempt, rollout ID.
- first attempted, last attempted, applied, rolled back 시각.

### `tool_deployment_audit`

팀 정책·개인 선택·권한 승인·롤백·차단 변경의 actor, before·after JSON과 시각을 기록한다. 비밀값과 local config content는 기록하지 않는다.

## shim 구성요소

### Manifest client

ETag와 protocol version을 사용해 원하는 상태를 조회한다. 서버가 없거나 응답이 잘못되면 현재 정상 설치를 그대로 유지하고 지수 backoff로 재시도한다.

### Reconciler

현재 managed state와 원하는 상태를 비교해 install, update, remove, no-op 계획을 만든다. 계획은 적용 전에 다시 검증하고 item 또는 Plugin 단위 transaction으로 실행한다.

### Source fetcher

공개 또는 짧은 수명의 private download URL에서 staging으로 받는다. archive 크기·파일 수·상대 경로·symlink를 검증하고 추출한 파일 트리의 digest를 재계산한다.

### Client adapters

Claude Code와 Codex adapter를 분리한다. 각 adapter는 임시 파일에 설정을 생성해 parse한 뒤 atomic rename한다. 기존 비관리 설정은 byte-level fixture와 구조 비교로 보존한다.

### Local secret handling

`toard-shim tool configure <slug>`가 masked prompt로 값을 받고 사용자 전용 `0600` 로컬 저장소에 기록한다. 로그와 report serialization 전에 secret type을 별도로 유지해 문자열 포맷팅을 금지한다.

stdio MCP의 client config에는 실제 command 대신 `toard-shim tool run-mcp <deployment-id>`를 관리 entry로 기록한다. launcher가 로컬 비밀값을 env로 주입한 뒤 고정된 실제 command와 args를 실행하므로 Claude·Codex 설정 파일에 비밀값을 복사하지 않는다.

### Managed state와 rollback

`~/.toard/tools/` 아래에 버전별 파일과 managed state를 둔다. 적용 전에 현재 정상 버전과 client config backup을 보존한다. 새 상태 검증이 실패하면 같은 process에서 즉시 복원하고 `rolled_back`을 보고한다.

## 자동 업데이트와 롤백

자동 업데이트 대상은 같은 catalog item, 같은 repository identity, 같은 source owner의 새 immutable version이다. 다음 변화가 있으면 자동 전이를 멈춘다.

- 새 환경변수 또는 network host.
- stdio command 변경, 실행 구성요소 추가, Plugin 구성요소 추가.
- source URL·repository owner·GitHub App installation identity 변경.
- 지원 클라이언트 제거 또는 manifest protocol의 비호환 변경.

팀 기본 도구는 팀 리더, 개인 설치는 해당 사용자가 차이를 확인하고 승인해야 업데이트를 재개한다. 자동 검사는 보안 감사를 의미하지 않는다. 자동 업데이트는 사용자가 이미 신뢰한 동일 publisher를 계속 신뢰한다는 정책이다.

팀 rollout 기본값:

1. preflight: server validation과 permission diff.
2. canary: 결정적 device cohort 중 최소 1대·10%, 30분.
3. expand: 50%, 60분.
4. active: 100%, target version을 last-known-good로 승격.

개인 설치도 여러 기기가 있으면 한 기기부터 적용하고, 한 기기면 local transaction 검증 후 즉시 활성화한다.

롤백 조건:

- config parse, 파일 적용 또는 MCP process 시작 검증 실패는 해당 기기 즉시 local rollback.
- 동일 rollout에서 2대 이상 또는 적용 기기의 20% 이상이 실패하면 server rollout 중단과 팀 target version 복귀.
- 팀 리더의 수동 rollback.
- global block 처리.

오프라인 기기는 manifest를 받지 않았으므로 coordinator가 이전 버전으로 복귀한 뒤 문제 버전을 건너뛴다.

## 오류 처리

- 서버·네트워크 불가: 현재 정상 도구를 유지하고 backoff. CLI 시작을 막지 않는다.
- source download 실패: staging을 폐기하고 현재 버전 유지.
- digest 불일치: 적용하지 않고 보안 오류 code 보고. 같은 version 자동 재시도는 제한한다.
- archive path traversal·symlink·제한 초과: version을 적용 불가로 보고.
- 기존 비관리 설정 충돌: 자동 덮어쓰기 없이 `conflict`.
- 비밀값 누락: 설치 실패가 아니라 `settings_required`.
- client config parse 실패: atomic write 전에 중단하거나 backup으로 즉시 복원.
- Plugin 일부 실패: 구성요소 전체 rollback.
- report 전송 실패: 로컬 bounded queue에 저장하고 다음 연결 때 멱등 재전송.
- server manifest가 더 새로운 protocol을 요구: `unsupported` 보고 후 현재 버전 유지.
- 팀 정책 제거·개인 제외: toard managed entry만 제거. 다른 개인 설치가 같은 item을 요구하면 유지.
- global block: 새 설치·업데이트를 즉시 중단하고 기존 managed 설치를 제거 대상으로 전환한다. 오류 사유와 actor는 감사 로그에 남긴다.

## 운영 화면

### 사용자

- 라이브러리 상세: 설치, 기기 범위, 설정 필요, 제외, 충돌 해결, 제거.
- 내 기기: 기기별 desired/applied version, 마지막 동기화, 상태와 오류 해결 동작.
- 내 도구: 개인 설치와 팀 상속을 구분하고 개인 제외를 되돌릴 수 있음.

### 팀 리더

- 팀 기본 도구 목록과 대상 사용자·기기 수.
- rollout 단계, 성공·설정 필요·충돌·실패·오프라인 수.
- 권한 확대 승인, rollout 일시중지·재개, version pin, 수동 rollback.
- 구성원별 secret 값은 볼 수 없고 `configured | missing` 상태만 볼 수 있음.

### 조직 관리자

- team leader 지정.
- 커뮤니티·검증 상태와 global block.
- block 영향 범위와 제거 진행률.
- 개별 사용자의 secret·local config·전체 command line은 볼 수 없음.

## 호환성과 배포

server와 shim은 `tool_deployment_v1` capability를 협상한다. 기존 shim은 카탈로그와 인벤토리를 계속 사용하지만 manifest 대상에서는 제외한다. UI는 지원 shim이 없는 기기에 `shim 업데이트 필요`를 표시한다.

기능은 하나의 제품 릴리스로 제공하되 내부 구현은 다음 독립 모듈로 나눈다.

1. version·manifest·desired state와 protocol.
2. shim reconciler, source fetcher, Claude·Codex adapters와 local rollback.
3. 개인 설치, 팀 leader 정책, 제외와 운영 UI.
4. rollout coordinator, 자동 업데이트, permission diff와 global block.

모든 모듈이 검증될 때까지 server feature flag로 manifest 발급을 비활성화할 수 있다. flag를 꺼도 이미 설치된 도구는 제거하지 않고 현재 상태를 유지한다.

## 테스트

### Core 단위 테스트

- 개인 선택·제외·팀 기본의 device별 우선순위.
- immutable version과 permission diff.
- deterministic canary cohort.
- 2대 또는 20% 실패 threshold와 rollout state machine.
- block, offline, unsupported capability가 원하는 상태에서 제외되는지.

### Repository·API 테스트

- member·leader·admin 권한 경계와 자기 팀 제한.
- manifest가 다른 사용자·팀·기기 항목을 포함하지 않음.
- secret field가 schema와 응답에 존재하지 않음.
- ETag 304, report 멱등, audit before·after 기록.
- private source URL 발급 시 GitHub token 미노출.
- 여러 coordinator replica가 한 rollout을 중복 전이하지 않음.

### shim 단위·fixture 테스트

- archive path traversal, symlink, 크기·파일 수 제한, canonical digest.
- Claude JSON과 Codex TOML에서 비관리 설정 보존.
- 같은 이름의 비관리 entry 충돌 감지.
- staging → validate → atomic write → managed state 순서.
- 각 실패 지점에서 직전 정상 버전과 config 복원.
- Plugin 전체 transaction rollback.
- local secret이 config, report, stdout·stderr, debug log에 나타나지 않음.
- server 불가와 protocol incompatibility가 실제 CLI 실행을 막지 않음.

### 통합 E2E

임시 HOME과 실제 server API를 사용해 다음 흐름을 검증한다.

1. 개인 설치 → 두 기기 적용 → 한 기기 설정 필요 → local configure → 설치됨.
2. 팀 leader 기본 지정 → online 적용 → offline 대기 → 재접속 적용.
3. 구성원 제외 → managed entry 제거 → 비관리 설정 유지.
4. 기존 수동 MCP 충돌 → 유지 선택 → 상태 정상화.
5. 새 버전 canary → 50% → 100%.
6. canary 실패 → local rollback과 server rollout 중단.
7. 권한 확대 버전 → 자동 중지 → leader 승인 → 재개.
8. global block → 새 설치 중단과 managed 제거.
9. server feature flag off → 기존 설치 유지.

### UI 검증

- 개인·leader·admin별로 허용된 동작만 노출.
- 설치 후 queued부터 terminal 상태까지 실시간 갱신.
- 390px에서 설치·설정·제외·충돌 해결 흐름의 가로 overflow 없음.
- 한국어·영어 문구와 상태 key shape 일치.
- 권한 확대와 rollback 사유가 일반 사용자가 이해할 수 있는 문장으로 표시됨.

## 완료 기준

- 온라인 지원 기기는 요청 후 90초 안에 terminal 상태를 보고한다.
- 비밀값이 server DB, API payload, audit, deployment report와 로그에 없음을 테스트로 증명한다.
- toard가 관리하지 않은 Claude·Codex 설정이 설치·업데이트·제외·롤백 뒤에도 보존된다.
- digest 불일치와 설정 검증 실패가 새 버전을 활성화하지 않는다.
- team leader만 자기 팀 기본 정책을 변경할 수 있고 admin 사전 승인 없이 적용된다.
- 구성원 제외가 다음 manifest 조회에 반영되고 모든 자기 대상 기기에서 제거된다.
- 자동 rollout과 local rollback이 process 재시작과 offline device를 포함해 결정적으로 동작한다.
- 기존 카탈로그 탐색, 공유, 인벤토리와 활동 수집이 지원하지 않는 shim에서도 회귀하지 않는다.
- migration up/down, core·web·shim tests, typecheck, formatter와 `git diff --check`가 통과한다.

## 구현 순서 원칙

한 번에 출시하되 하나의 거대한 변경으로 구현하지 않는다. protocol과 version 모델을 먼저 고정하고, shim transaction과 보존 규칙을 검증한 뒤 UI와 rollout을 연결한다. 각 모듈은 feature flag 뒤에서 개별 검증할 수 있어야 하며, 마지막 검증 전에는 실제 기기에 manifest를 발급하지 않는다.
