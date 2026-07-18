# shim 멀티 target fan-out 설계

## 배경

현재 shim은 한 macOS/Windows/Linux 사용자 계정에서 `~/.toard/credentials` 하나와 `~/.toard/state/cursors/` 하나만 사용한다. 따라서 설치 스크립트를 다른 toard 서버에서 다시 실행하면 기존 endpoint와 token이 덮어써지고, 하나의 cursor를 여러 서버가 공유해 같은 로컬 사용량을 두 서버에 독립적으로 전달할 수 없다.

필요한 실제 배치는 한 컴퓨터에서 shim과 주기 수집 daemon은 하나만 유지하되, 회사 toard와 개인 toard를 포함한 임의 개수의 서버에 같은 로컬 사용량·도구 메타데이터·프롬프트/응답을 전송하는 것이다. 회사 서버가 일시적으로 접근 불가능해도 개인 서버 전송은 계속되어야 하며, 회사 서버가 다시 접근 가능해지면 회사 서버에 아직 보내지 않은 데이터만 이어서 전송해야 한다.

기존 설치의 회사 endpoint, token, cursor는 신버전 shim으로 업데이트할 때 보존해야 한다. 아직 업데이트하지 않은 구버전 shim과 구버전 toard 서버의 현재 ingest API도 계속 동작해야 한다. 프로젝트가 0.x 개발 단계이므로 새 저장 형식으로 전진 마이그레이션한 뒤 구버전 shim으로 자동 롤백하는 기능은 요구하지 않는다.

## 목표

- 사용자 계정당 shim 바이너리와 daemon을 하나만 실행한다.
- 로컬 로그를 한 번 발견하고 파싱해 임의 개수의 toard target으로 fan-out한다.
- endpoint·token·수집 정책·cursor·기능 지원 상태·최근 전송 결과를 target별로 격리한다.
- 한 target의 연결·인증·서버 오류가 다른 target 전송을 막지 않게 한다.
- 실패한 target의 cursor만 멈추고 다음 수집 주기에 자동으로 재시도한다.
- 기존 단일 credentials와 상태를 데이터 손실이나 의도하지 않은 전체 재전송 없이 새 구조로 이전한다.
- toard UI가 제공하는 `install.sh`·`install.ps1`을 target 추가·갱신의 기본 인터페이스로 만든다.
- toard UI가 제공하는 `uninstall.sh`·`uninstall.ps1`은 자신을 제공한 서버의 target만 제거한다.
- 마지막 target을 제거할 때만 daemon·shim 바이너리·toard 소유 PATH 설정을 모두 정리한다.
- token을 명령 인자, 프로세스 목록, 진단 출력, 로그에 노출하지 않는다.
- 현재 서버 ingest endpoint와 payload 계약을 유지해 구버전 서버·shim과 wire 호환성을 보존한다.

## 범위 제외

- KMS 또는 E2EE 암호화 모델의 선택·변경.
- 서버 사이에서 데이터를 복제하거나 한 서버를 relay로 사용하는 구조.
- 원본 Claude/Codex/Gemini/Qwen 로그가 로컬에서 삭제된 뒤에도 전달을 보장하는 별도 durable outbox.
- 구버전 shim으로 자동 downgrade하거나 새 `targets/` 상태를 구버전 형식에 계속 mirror하는 기능.
- target별 프로젝트·디렉터리·provider 필터링.
- target 사이의 우선순위 또는 primary/secondary 의미.
- experimental OTLP push를 여러 endpoint로 fan-out하는 기능.
- 현재 E2EE setup/approve CLI를 멀티 target UX로 확장하는 작업.

본문 보호 방식은 별도 KMS 작업의 계약을 따른다. 이 설계는 본문 수집 여부와 전송 cursor를 target별로 분리할 뿐 암호화 방식을 새로 정의하지 않는다.

## 핵심 결정

### 단일 shim 내부 fan-out

프로필별 shim이나 daemon을 여러 개 실행하지 않는다. 하나의 수집 실행이 adapter별 로컬 파일을 한 번 발견하고, 필요한 파일을 한 번 파싱한 뒤 target별 delivery 단계로 결과를 나눈다.

```text
Claude/Codex/Gemini/Qwen 로컬 로그
                |
                v
        발견·파싱 1회
                |
                v
       정규화된 로컬 레코드
          /       |       \
         v        v        v
      회사 target 개인 target 추가 target
      전용 cursor 전용 cursor 전용 cursor
```

target 하나가 실패해도 다른 target delivery는 끝까지 실행한다. target의 cursor는 해당 target에 필요한 모든 chunk가 성공한 뒤에만 갱신한다.

### `targets/`를 유일한 정식 저장소로 사용

모든 target은 동일한 디렉터리 구조를 사용한다.

```text
~/.toard/
├── bin/
│   ├── claude
│   ├── codex
│   └── toard-shim
├── targets/
│   ├── <target-id>/
│   │   ├── credentials
│   │   └── state/
│   │       ├── cursors/
│   │       ├── content-since
│   │       ├── tool-since
│   │       ├── tool-inventory.json
│   │       ├── unsupported-tool-events
│   │       ├── unsupported-tool-inventory
│   │       ├── unsupported-usage-reconciliation
│   │       └── delivery.json
│   └── <target-id>/...
└── state/
    ├── last-collect
    ├── last-update-check
    ├── daemon-log-rotate
    ├── daemon.log
    ├── daemon.err.log
    ├── claude-env.json
    └── tmp/
```

target별 상태는 다음과 같다.

- usage·tool event·content cursor와 Codex reconciliation version
- `content-since`와 `tool-since`
- 현재 tool inventory의 target별 전달 상태
- 서버가 지원하지 않는 endpoint의 24시간 probe stamp
- 최근 시도·성공·실패 분류와 제한된 오류 지문

shim 전역 상태는 다음과 같다.

- wrap·daemon·수동 수집이 공유하는 `last-collect`
- 자동 업데이트와 daemon 로그 로테이션 stamp
- daemon 로그와 임시 HTTP body 파일
- shim 바이너리 하나에 귀속되는 `claude-env` 관리 상태

tool inventory의 로컬 파일 스캔 결과는 한 번 계산할 수 있지만, 어느 서버에 성공적으로 전달됐는지는 target별로 저장해야 한다. 한 서버 전송 성공이 다른 서버의 inventory 전송을 생략하게 해서는 안 된다.

### target ID와 endpoint 정규화

target ID는 token이나 사용자 입력 label이 아니라 정규화한 ingest endpoint의 SHA-256 hex 값으로 만든다.

정규화는 다음 규칙을 따른다.

- URL parser로 scheme, host, port, path를 검증한다.
- scheme과 host는 소문자로 정규화한다.
- 기본 포트는 제거한다.
- 끝의 `/`는 제거한다.
- query, fragment, userinfo가 있는 endpoint는 거부한다.
- path의 대소문자는 보존한다.
- 정규화 결과는 credentials의 `endpoint`에도 저장한다.

같은 endpoint의 설치 스크립트를 다시 실행하면 같은 target ID가 선택된다. token이나 수집 정책이 바뀌어도 cursor와 since 상태는 유지한다. 해시 전체를 디렉터리 이름으로 사용해 별도 충돌 해결 규칙이 필요 없게 한다.

### target credentials

`targets/<target-id>/credentials`는 현재 key-value 형식을 유지한다. 최소 필드는 다음과 같다.

```text
agent_key=<ingest token>
endpoint=https://toard.example/api
collect_content=<현재 정책 값>
collect_tools=<현재 정책 값>
```

현재 버전에 존재하는 추가 content metadata는 해당 content 모드가 요구하는 동안 target credentials에 함께 보존한다. KMS 작업이 이 필드를 대체하더라도 target registry와 delivery 경계는 바꾸지 않는다.

Unix에서는 `~/.toard`와 `targets` 디렉터리를 `0700`, credentials와 cursor·delivery 상태를 `0600`으로 생성한다. Windows에서는 사용자 profile 아래에 저장하고 현재 사용자만 접근할 수 있도록 기존 설치기의 ACL 계약을 유지·검증한다. token은 목록·doctor·오류에 표시하지 않는다.

## 기존 설치 전진 마이그레이션

### 입력

레거시 설치는 다음 경로를 사용한다.

```text
~/.toard/credentials
~/.toard/state/cursors/
~/.toard/state/content-since
~/.toard/state/tool-since
~/.toard/state/tool-inventory.json
~/.toard/state/unsupported-*
```

기존 `last-collect`, updater, daemon, 로그, `claude-env`, 임시 파일은 shim 전역 상태이므로 새 전역 `state/` 위치에 그대로 남긴다.

### 절차

새 shim이 target registry를 처음 읽거나 `target upsert`를 실행할 때 cross-platform 설정 잠금을 획득하고 다음 절차를 수행한다.

1. 레거시 credentials가 없으면 마이그레이션을 건너뛴다.
2. token과 endpoint를 파싱하고 endpoint를 정규화한다.
3. target ID를 계산한다.
4. `targets/.migrate-<pid>/` 임시 디렉터리에 credentials와 target별 상태를 복사한다.
5. credentials에 secret 값이 존재하고 모든 복사 파일을 다시 읽을 수 있는지 검증한다.
6. 이미 같은 target이 있으면 credentials는 갱신하되 기존 target cursor를 우선한다. 레거시 cursor로 기존 target cursor를 덮지 않는다.
7. 새 target이면 임시 디렉터리를 `targets/<target-id>/`로 원자적 rename한다.
8. 마이그레이션 성공 marker와 원본 파일 목록을 기록한다.
9. 레거시 target별 파일은 권한을 유지해 `~/.toard/legacy-backup/<timestamp>/`로 이동한다. 이 backup은 실행 시 읽지 않는 복구 자료이며 credentials는 계속 `0600`으로 보호한다.

마이그레이션 성공 전에는 레거시 파일을 삭제하거나 개인 서버 credentials를 쓰지 않는다. 실패하면 기존 레거시 credentials와 cursor를 in-memory fallback target으로 사용해 기존 회사 전송을 계속하고, 새 target 추가는 실패로 종료한다.

마이그레이션 후 구버전 서버의 옛 installer가 `~/.toard/credentials`를 다시 생성할 수 있다. 새 shim은 registry를 읽을 때 새 레거시 파일을 같은 단방향 절차로 import하고, endpoint가 같으면 해당 target credentials만 갱신하며, endpoint가 다르면 새 target으로 추가한다. 새 shim은 `targets/` 내용을 레거시 경로로 다시 mirror하지 않는다.

## 설치와 갱신

### UI가 제공하는 설치 스크립트가 정식 인터페이스

사용자가 보는 명령 형태는 유지한다.

```sh
curl -fsSL '<toard>/install.sh' | TOARD_INGEST_TOKEN='<token>' sh
```

```powershell
$env:TOARD_INGEST_TOKEN='<token>'; irm '<toard>/install.ps1' | iex
```

스크립트 내부 순서는 다음과 같이 바꾼다.

1. 바이너리를 checksum 검증 후 설치하되 daemon 자동 등록은 잠시 끈다.
2. 설치된 바이너리가 `target upsert` capability를 제공하는지 확인한다.
3. capability가 없으면 credentials를 변경하지 않고 실패한다.
4. 스크립트를 제공한 서버의 endpoint, token, content/tool 정책을 환경변수로 전달해 `toard-shim target upsert`를 실행한다.
5. `target upsert`가 레거시 마이그레이션을 먼저 완료한 뒤 현재 endpoint를 추가·갱신한다.
6. target 등록 성공 후 daemon을 멱등 등록한다.
7. installer가 전달한 endpoint에 해당하는 target만 doctor로 확인한다.
8. 현재 target 확인이 성공한 경우에만 설치 완료를 출력한다.

token은 환경변수로만 전달하고 CLI 인자로 넣지 않는다. installer는 credentials 파일을 직접 조립하거나 덮어쓰지 않는다.

같은 endpoint의 재설치는 다음 상태만 갱신한다.

- token
- target별 content 수집 정책
- target별 tool 수집 정책
- 명시적으로 전달된 backfill 정책

cursor, `content-since`, `tool-since`, 최근 성공 상태는 유지한다. 다른 endpoint의 재설치는 기존 target을 변경하지 않고 새 target을 추가한다.

### CLI의 위치

CLI는 installer/uninstaller가 사용하는 내부 엔진이자 고급 복구 경로다.

```text
toard-shim targets list
toard-shim target upsert
toard-shim target remove
toard-shim doctor
```

- `targets list`는 target ID의 짧은 prefix, endpoint, 수집 정책, 최근 성공·오류를 표시한다.
- `target upsert`는 endpoint와 token을 환경변수에서 읽는다.
- `target remove`는 endpoint를 환경변수에서 읽고 machine-readable 제거 결과를 제공한다.
- `doctor`는 모든 target을 독립 진단한다.
- installer는 자신이 추가한 target만 진단할 수 있는 target 선택 모드를 사용한다. 다른 target이 접근 불가능해도 현재 설치 성공을 실패로 표시하지 않는다.

일반 도움말과 README는 UI의 설치·제거 스크립트를 먼저 안내하고 CLI는 고급 관리로 설명한다.

### 기존 환경변수 호환

`TOARD_INGEST_TOKEN`과 `TOARD_INGEST_ENDPOINT` 쌍은 installer의 `target upsert`와 target 선택 doctor에서 계속 사용한다. registry가 없는 상태에서 사용자가 직접 `collect`에 두 값을 전달하는 기존 자동화는 하나의 임시 legacy target으로 계속 동작한다. registry가 하나 이상 있으면 일반 `collect`는 registry를 권위로 사용하고, 환경변수 target을 암묵적으로 추가하거나 전체 target을 덮어쓰지 않는다.

`TOARD_SHIM_COLLECT_CONTENT=0`과 `TOARD_SHIM_COLLECT_TOOLS=0`은 로컬 안전 중단 스위치로 모든 target에 적용한다. 환경변수로 수집을 켜는 동작은 각 target에 저장된 content mode와 서버 정책을 우회하지 않는다.

## 제거

`/uninstall.sh`와 `/uninstall.ps1`은 정적 전체 제거기가 아니라 요청 서버의 public ingest endpoint를 포함하는 동적 target 제거기로 바꾼다.

```text
개인 toard의 uninstall script
  -> 개인 endpoint 정규화
  -> 개인 target만 제거
  -> 남은 target 수 확인
  -> 1개 이상이면 shim·daemon 유지
  -> 0개이면 전체 shim 정리
```

`target remove`는 설정 잠금 안에서 정확한 target을 선택하고 `{ removed, remaining }` 결과를 machine-readable 형식으로 반환한다.

- target이 존재하면 credentials와 target별 state를 제거한다.
- target이 없으면 멱등 성공으로 처리하되 `removed=false`를 반환한다.
- `removed=false`인 경우 remaining이 0이어도 전체 정리를 실행하지 않는다.
- 실제 target 제거 결과가 `removed=true, remaining=0`일 때만 전체 제거로 승격한다.
- 미전송 데이터가 있을 수 있음을 UI와 스크립트가 경고한다.

마지막 target 제거 시 스크립트는 다음 순서로 정리한다.

1. daemon을 먼저 해제한다.
2. toard가 관리한 experimental OTLP 설정을 기존 안전 규칙으로 제거한다.
3. shim alias와 바이너리를 제거한다.
4. target registry, 레거시 migration backup, shim 전역 상태를 제거한다.
5. toard marker가 있는 PATH 항목만 제거한다.
6. 실제 Claude/Codex 설치와 원본 세션 로그는 건드리지 않는다.

구버전 서버의 기존 uninstall script는 target 개념을 모르므로 전환 기간에 shim 바이너리를 전체 제거할 수 있다. 현재 구버전 스크립트는 새 `targets/`를 알지 못해 target credentials와 cursor는 남긴다. 신버전 installer를 다시 실행하면 바이너리와 daemon을 복구하고 target 전송을 재개할 수 있다. 개인 서버 검증 후 회사 서버도 신버전으로 업데이트해 이 전환 제한을 제거한다.

## 수집 데이터 흐름

### 공통 준비

한 수집 실행은 다음을 한 번만 수행한다.

- target registry 로드와 필요 시 레거시 import
- host label 계산
- adapter별 파일 발견과 stamp 조회
- 현재 tool inventory를 위한 로컬 설정 스캔
- daemon 로그 로테이션과 전역 수집 stamp 갱신

target 목록은 endpoint 정규화 값으로 중복 제거하고 target ID 순서로 안정적으로 처리한다.

### usage

usage는 target별 cursor가 없는 경우 현재 정책대로 로컬 로그 전체를 백필한다. 파일을 한 번 파싱해 정규화된 `UsageEvent`와 dedup key를 만들고, target별 cursor의 `sent`와 `sent_hash`를 적용해 target마다 필요한 suffix를 계산한다.

한 target의 모든 usage chunk가 성공하면 해당 target의 usage cursor만 갱신한다. 실패하면 갱신하지 않아 다음 실행에서 같은 suffix를 다시 보낸다. 서버 dedup key가 부분 성공 뒤 재시도 중복을 흡수한다.

Codex replay reconciliation 상태와 unsupported probe도 target별로 분리한다. 신버전 서버에서 reconciliation이 성공했다고 해서 구버전 서버의 probe나 cursor를 완료 처리하지 않는다.

### tool events와 inventory

새 target의 tool event cursor는 현재 정책대로 기존 파일 stamp를 baseline으로 만들고 target 추가 이후 이벤트부터 전송한다. target마다 `collect_tools`, `tool-since`, unsupported probe를 적용한다.

tool inventory 자체는 한 번 스캔하지만 현재 fingerprint가 각 target에 성공적으로 전달됐는지는 target별로 기록한다. 한 target이 tool inventory endpoint를 지원하지 않거나 실패해도 다른 target의 snapshot 전송을 막지 않는다.

### prompt/response content

content가 활성화된 target이 하나라도 있을 때 adapter별 content를 한 번 파싱한다. 각 target은 자신의 `collect_content`와 `content-since`를 적용한다.

- 새 target의 기본 `content-since`는 현재 정책대로 target 추가 시각이다.
- 명시적인 날짜 또는 `all`은 해당 target에만 적용한다.
- target의 endpoint 안전성 검사는 독립적으로 수행한다.
- target별 content 변환·암호화가 필요한 현재 모드는 target credentials를 사용한다.
- KMS 기반 서버 암호화가 적용되면 동일한 fan-out과 cursor 경계를 유지하고 content payload 생성 단계만 그 계약을 따른다.

content target이 disabled 응답을 반환하면 해당 target cursor를 갱신하지 않고 다른 target 전송을 계속한다.

### experimental OTLP와 기존 E2EE CLI

멀티 target fan-out의 권위 경로는 로컬 로그 pull 수집이다. experimental OTLP 설정은 구조상 endpoint 하나만 주입할 수 있으므로 target이 둘 이상이면 자동 주입과 `claude-env on`을 거부하고 pull 수집을 안내한다. target이 정확히 하나인 기존 사용은 현재 experimental 동작을 유지한다.

현재 E2EE setup/approve CLI는 이 설계에서 멀티 target 선택 기능을 추가하지 않는다. target이 하나일 때만 기존 동작을 유지하고, 둘 이상이면 명확한 오류를 반환한다. 이후 KMS 기반 서버 암호화 작업이 이 경로를 교체하더라도 registry·cursor·fan-out 계약은 그대로 유지한다.

## 오류 처리와 관측성

각 target의 `delivery.json`에는 secret이나 응답 본문 없이 다음만 기록한다.

- `last_attempt_at`
- `last_success_at`
- 최근 결과 분류: success, unreachable, unauthorized, unsupported, disabled, server_error
- sanitizing한 오류 지문과 마지막 로그 시각

접근 불가능한 회사 서버도 기본 수집 주기마다 짧은 연결 시도를 계속해 사내망 복귀 후 빠르게 재개한다. 연결 단계 timeout을 짧게 제한해 접근 불가능한 target 하나가 다른 target 전송을 장시간 지연시키지 않게 하고, 전송 본문이 진행 중인 요청에는 기존 전체 요청 timeout을 적용한다. 동일한 오류 메시지는 target별로 제한적으로만 로그에 남겨 daemon 로그가 반복 오류로 커지지 않게 한다. 수동 `collect`와 `doctor`는 현재 오류를 항상 표시한다.

실패 target의 재전송 가능 범위는 로컬 원본 로그가 남아 있는 기간까지다. 별도 durable outbox를 만들지 않으므로 장기간 장애 중 사용자가 원본 세션 로그를 삭제하면 해당 target에 그 데이터를 복구할 수 없다는 현재 pull 수집 한계를 doctor와 문서에 명시한다.

전체 collect 종료 코드는 다음 원칙을 따른다.

- 모든 활성 target 성공: 0
- 하나 이상의 target delivery 실패: 1
- 잘못된 CLI 사용이나 adapter 선택: 2

부분 실패여도 background collect는 Claude/Codex 실행을 막지 않는다. daemon은 다음 주기에 다시 실행된다.

`doctor`는 target마다 endpoint 연결, token 인증, 최근 성공, cursor 상태를 별도 행으로 표시하고 마지막에 전체 요약을 제공한다. token과 Authorization header는 표시하지 않는다.

## 동시성·원자성·안전성

- registry migration, upsert, remove는 동일한 cross-platform 설정 잠금을 사용한다.
- target credentials와 JSON 상태는 임시 파일 작성 후 rename으로 교체한다.
- collect가 cursor를 저장할 때 target 존재 여부를 다시 확인한다. 제거된 target을 되살리지 않는다.
- installer는 target upsert 성공 전 daemon을 등록하지 않는다.
- uninstaller는 daemon 해제 전 바이너리를 제거하지 않는다.
- target ID는 검증된 hex 값만 경로에 사용하고 endpoint나 token을 파일명에 넣지 않는다.
- HTTP body 임시 파일은 `0600`으로 생성하고 전송 뒤 제거한다.
- endpoint 오류 문자열과 서버 응답은 token 또는 본문을 포함할 수 있으므로 그대로 지속 상태에 저장하지 않는다.
- 프로덕션 DB를 직접 수정하지 않는다. 이 기능은 shim 로컬 상태와 기존 ingest API만 사용한다.

## 호환성

### 서버 wire 호환성

다음 endpoint와 payload 계약을 변경하지 않는다.

- `POST /api/v1/events`
- `POST /api/v1/prompts`
- `POST /api/v1/tool-events`
- `PUT /api/v1/tool-inventory`
- `POST /api/v1/events/reconcile`

각 target token이 기존처럼 서버에서 사용자와 조직을 결정한다. 따라서 신버전 shim은 구버전 회사 서버로 계속 전송할 수 있고, 업데이트하지 않은 구버전 shim도 신버전 서버의 기존 API로 계속 전송할 수 있다.

### 로컬 저장 형식 호환성

- 구버전 단일 credentials와 cursor는 신버전 shim이 최초 1회 import한다.
- import 성공 후 `targets/`가 유일한 정식 저장소다.
- 레거시 파일은 backup으로만 남고 계속 mirror하지 않는다.
- 구버전으로 자동 downgrade는 지원하지 않는다.
- 구버전 installer가 다시 만든 레거시 credentials는 새 shim이 단방향으로 다시 import한다.

## 테스트 전략

### Rust 단위 테스트

- endpoint 정규화와 안정적인 target ID
- query·fragment·userinfo·잘못된 URL 거부
- target credentials parse, 저장 권한, token 비출력
- 같은 endpoint upsert의 멱등성과 cursor 보존
- 다른 endpoint upsert의 기존 target 보존
- target 목록 중복 제거와 안정적 정렬
- target별 cursor·since·unsupported·inventory state 경로
- 레거시 credentials와 모든 target별 상태의 최초 마이그레이션
- 마이그레이션 중 실패 시 레거시 fallback과 새 target 미생성
- 이미 존재하는 target으로 레거시 재import 시 cursor 비덮어쓰기
- 한 target 성공·한 target 실패 시 성공 target cursor만 갱신
- 실패 target 복구 후 실패 target suffix만 재전송
- tool inventory의 target별 성공 상태
- 존재하지 않는 target 제거가 전체 제거 조건을 만들지 않음
- 마지막 target 제거 결과의 `removed=true, remaining=0` 계약
- doctor의 target별 요약과 secret redaction
- registry 유무에 따른 기존 ingest 환경변수 호환과 암묵적 target 덮어쓰기 방지
- 멀티 target에서 experimental OTLP·기존 E2EE CLI의 명시적 거부

### installer·uninstaller 생성 테스트

- POSIX installer가 credentials를 직접 덮어쓰지 않고 `target upsert`를 호출
- PowerShell installer도 동일한 target upsert 계약 사용
- installer가 capability 확인 전 로컬 설정을 변경하지 않음
- target upsert 전 daemon을 등록하지 않음
- installer doctor가 현재 endpoint target만 확인
- POSIX·PowerShell uninstaller가 요청 서버 endpoint만 target remove에 전달
- `removed=true, remaining=0`일 때만 전체 파일과 PATH 정리
- target이 남으면 daemon·바이너리·PATH 유지
- token이 생성 스크립트 출력이나 관리 명령 인자에 포함되지 않음
- POSIX 권한과 Windows 현재 사용자 ACL

### 통합 테스트

필수 대표 시나리오는 다음과 같다.

1. 구버전 회사 credentials와 진행된 usage·tool·content cursor를 fixture HOME에 만든다.
2. 신버전 개인 서버 installer를 실행한다.
3. 회사 설정과 cursor가 회사 target으로 이전됐는지 확인한다.
4. 개인 target이 추가됐는지 확인한다.
5. 회사 mock 서버를 실패시키고 개인 mock 서버만 성공시킨다.
6. 개인 cursor만 진행되고 회사 cursor는 유지되는지 확인한다.
7. 회사 mock 서버를 복구하고 다음 collect에서 회사 누락분만 전송되는지 확인한다.
8. 동일한 개인 installer 재실행이 target을 중복 생성하거나 cursor를 초기화하지 않는지 확인한다.
9. 개인 uninstaller가 개인 target만 제거하고 회사 전송을 유지하는지 확인한다.
10. 회사 uninstaller로 마지막 target을 제거하면 daemon·shim·PATH가 정리되는지 확인한다.

추가로 usage 전체 백필, tool·content 추가 시점 기준, tool inventory, reconciliation, partial chunk 실패 후 dedup 재시도를 각각 검증한다.

### 전체 검증

- `cargo fmt --manifest-path shim/rust/Cargo.toml -- --check`
- `cargo test --manifest-path shim/rust/Cargo.toml`
- `cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings`
- web installer/uninstaller 관련 테스트
- `pnpm typecheck`
- `git diff --check`
- Unix installer 대역 통합 테스트
- GitHub Actions `windows-latest`의 PowerShell parse·네이티브 shim 테스트

현재 로컬 환경에 Rust toolchain이 없으면 로컬에서 실행하지 못한 Rust 검증을 명시하고, CI 결과 없이 완료를 주장하지 않는다.

## 롤아웃 순서

1. target registry와 fan-out을 지원하는 shim 릴리스를 먼저 게시한다.
2. 개인 toard 서버를 신버전으로 배포한다.
3. 개인 서버 UI의 installer를 기존 회사 shim이 설치된 Mac에서 실행한다.
4. `targets list`와 target별 doctor로 회사 마이그레이션과 개인 target 추가를 확인한다.
5. 두 서버 전송과 회사 실패·복구 시나리오를 확인한다.
6. 회사 toard 서버를 신버전으로 배포해 target-aware install/uninstall script를 제공한다.
7. 전환 기간에 구버전 회사 uninstaller를 실행하지 않도록 안내한다.

installer가 target capability를 확인하므로 shim 릴리스보다 서버 installer가 먼저 배포돼 기존 credentials를 손상시키는 순서 역전은 실패 안전하게 중단된다.

## 완료 기준

- 한 사용자 계정에서 shim·daemon 하나가 임의 개수의 target을 처리한다.
- 회사와 개인 target에 usage·tool metadata·활성화된 content가 각각 전송된다.
- target별 token·정책·cursor·since·기능 probe·최근 상태가 격리된다.
- 회사 endpoint가 실패해도 개인 cursor와 전송은 진행한다.
- 회사 endpoint가 복구되면 회사 cursor 기준 누락분만 자동 전송한다.
- 기존 회사 credentials와 cursor가 최초 신버전 설치에서 보존된다.
- 신규 installer는 기존 target을 유지하며 자신의 endpoint를 upsert한다.
- 같은 endpoint 재설치는 target을 중복 생성하거나 cursor를 초기화하지 않는다.
- 서버별 uninstaller는 자신의 target만 제거한다.
- 마지막 target 제거만 전체 shim을 정리한다.
- 존재하지 않는 target 제거는 전체 shim 정리를 유발하지 않는다.
- 구버전 회사 서버와 신버전 shim, 구버전 shim과 신버전 서버의 기존 ingest 계약이 유지된다.
- token과 본문이 명령 인자·진단·지속 오류 상태에 노출되지 않는다.
- 필수 단위·통합·스크립트 검증이 통과한다.
