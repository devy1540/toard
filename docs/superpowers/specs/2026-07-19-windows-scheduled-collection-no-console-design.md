# Windows 예약 수집 무창 실행 설계

- 상태: 사용자 승인 완료
- 작성일: 2026-07-19
- 대상: Windows `toard-collect` 예약 작업, Windows 설치·제거, shim 릴리스·업데이트

## 1. 결정 요약

Windows의 `toard-collect` 예약 작업이 콘솔 subsystem인 `toard-shim.exe`를
대화형 사용자 세션에서 직접 실행해 5분마다 콘솔 창이 나타났다 사라지는 문제를
수정한다.

CLI용 `toard-shim.exe`는 콘솔 프로그램으로 유지한다. 대신 Windows GUI subsystem으로
링크된 최소 전용 실행 파일 `toard-shim-background.exe`를 추가한다. 예약 작업은 이
무창 실행 파일을 시작하고, 실행 파일은 같은 디렉터리의 `toard-shim.exe`를
`collect --quiet` 인자와 `CREATE_NO_WINDOW`로 실행한 뒤 종료 코드를 그대로 반환한다.

새 설치는 두 실행 파일을 함께 내려받아 SHA256을 검증하고 예약 작업을 무창 실행
파일로 등록한다. 기존 설치는 새 릴리스 배포 후 기존 연결 명령(`install.ps1`)을 한 번
다시 실행해 실행 파일과 예약 작업을 함께 교체한다. 이 재실행은 기존 target을
upsert하므로 다른 서버 target과 각 target의 cursor를 보존한다.

## 2. 확인된 원인

현재 구현의 Windows 동작은 다음과 같다.

1. 설치기가 `toard-shim.exe daemon install`을 호출한다.
2. daemon은 로그인한 사용자의 `InteractiveToken`과 5분 반복 trigger로
   `toard-collect` 작업을 등록한다.
3. 작업 action은 `toard-shim.exe collect --quiet`를 직접 실행한다.
4. 배포된 Windows shim의 PE subsystem은 `Windows CUI`다.
5. Task Scheduler에는 부모 콘솔이 없으므로 Windows가 새 콘솔을 만들고, 수집 종료와
   함께 창이 닫힌다. `--quiet`는 stdout/stderr만 줄이며 콘솔 생성을 막지 않는다.

따라서 실행이 시작된 뒤 shim 내부에서 콘솔을 숨기는 처리는 너무 늦다. 콘솔형 shim을
시작하는 부모가 `CREATE_NO_WINDOW`를 사용하거나, 처음부터 GUI subsystem인 진입점이
필요하다.

## 3. 목표

- Windows 예약 수집이 사용자 화면에 콘솔·PowerShell 창을 만들지 않는다.
- `toard-shim doctor`, `update`, `daemon`, `targets` 등 CLI 출력과 종료 코드 계약은
  유지한다.
- Windows 작업은 계속 현재 로그인 사용자의 최소 권한으로 실행한다.
- 기존 5분 주기, `StartWhenAvailable`, 중복 실행 방지, target별 수집 동작을 유지한다.
- 설치·업데이트 자산은 기존과 동일하게 SHA256 검증 후 적용한다.
- 마지막 target 제거 전에는 무창 실행 파일과 예약 작업을 보존한다.
- Windows 네이티브 CI에서 helper의 GUI subsystem과 예약 작업 action을 검증한다.

## 4. 비목표

- macOS launchd 또는 Linux systemd/cron 동작 변경
- 수집 주기나 수집 정책 변경
- Task Scheduler principal을 S4U·서비스 계정으로 변경
- 전체 shim을 GUI subsystem으로 전환
- 사용자 세션이 로그아웃된 동안 Windows 수집 지원

## 5. 검토한 접근

### 5.1 PowerShell `-WindowStyle Hidden`

예약 작업이 PowerShell을 실행하고 PowerShell이 shim을 숨김 상태로 시작하는 방식이다.
추가 바이너리가 필요 없지만 PowerShell 자체가 콘솔 프로세스로 시작된 뒤 창 스타일을
처리하므로 짧은 flash를 구조적으로 배제하기 어렵다. 실행 정책과 보안 제품의 영향도
추가된다. 채택하지 않는다.

### 5.2 비대화형 Task Scheduler principal

작업을 비대화형 세션에서 실행하면 창은 보이지 않는다. 그러나 S4U는 네트워크와
사용자 암호화 자원 접근에 제약이 있어 원격 ingest와 사용자 keyring을 사용하는 현재
수집 계약에 맞지 않는다. 채택하지 않는다.

### 5.3 네이티브 GUI-subsystem 무창 실행 파일

GUI subsystem인 작은 실행 파일이 `CREATE_NO_WINDOW`로 기존 콘솔 shim을 실행한다.
CLI 바이너리의 입출력 계약과 Task Scheduler의 현재 사용자 보안 경계를 모두
유지하면서 창 생성을 결정론적으로 차단할 수 있다. 릴리스 자산 하나가 늘지만 동작과
검증 경계가 명확하다. 채택한다.

## 6. 구성 요소

### 6.1 `toard-shim-background.exe`

Windows 전용 책임만 갖는 별도 Rust binary target을 추가한다.

- crate root에 `windows_subsystem = "windows"`를 지정한다.
- 자기 실행 파일의 부모 디렉터리에서 `toard-shim.exe`를 찾는다.
- stdin/stdout/stderr를 null로 연결한다.
- `collect --quiet` 인자로 자식 프로세스를 실행한다.
- Windows `CREATE_NO_WINDOW` creation flag를 지정한다.
- spawn 실패 또는 비정상 종료를 자신의 0이 아닌 종료 코드로 반환한다.
- target, token, endpoint, 수집 로직을 직접 구현하지 않는다.

helper는 수집 로직을 복제하지 않는 안정적인 process boundary다. 실제 정책과 데이터
처리는 항상 현재 `toard-shim.exe`가 담당한다.

### 6.2 Windows 예약 작업

기존 작업 이름과 security principal은 유지한다.

- 작업 이름: `toard-collect`
- trigger: 기본 5분 반복
- principal: 현재 사용자 SID, `InteractiveToken`, `LeastPrivilege`
- command: `%USERPROFILE%\.toard\bin\toard-shim-background.exe`
- arguments: 없음

상태 조회는 기존 XML의 enabled·interval 판정을 유지한다. doctor에는 기존과 동일하게
`Windows Task Scheduler`로 표시한다.

### 6.3 설치와 제거

PowerShell 설치기는 다음 순서를 따른다.

1. main shim과 background helper를 임시 디렉터리에 내려받는다.
2. `SHA256SUMS`에서 두 자산의 항목을 각각 찾는다.
3. 두 파일의 SHA256이 모두 일치한 뒤 설치 디렉터리를 변경한다.
4. `claude.exe`, `codex.exe`, `toard-shim.exe`, `toard-shim-background.exe`를 배치한다.
5. 기존 target upsert와 ACL·PATH 설정을 수행한다.
6. `daemon install`로 기존 `toard-collect` 작업을 helper action으로 덮어쓴다.
7. doctor로 설치 결과를 확인한다.

target이 하나 이상 남는 제거는 helper와 예약 작업을 유지한다. 마지막 target 제거만
예약 작업을 해제하고 helper를 포함한 toard 소유 실행 파일을 정리한다.

### 6.4 릴리스와 이후 업데이트

Windows 릴리스 job은 같은 toolchain으로 다음 두 자산을 만든다.

- `toard-shim-x86_64-pc-windows-msvc.exe`
- `toard-shim-background-x86_64-pc-windows-msvc.exe`

두 자산 모두 공용 `SHA256SUMS`에 포함한다. 고정 릴리스로 마이그레이션한 뒤의 Windows
self-update는 main shim과 설치된 helper를 함께 검증·교체해 버전 구성을 일치시킨다.

기존 버전의 updater는 helper를 알지 못하므로 최초 전환은 `toard-shim update`만으로
완료됐다고 간주하지 않는다. 사용자는 새 릴리스 배포 후 서버의 기존 Windows 연결
명령을 한 번 다시 실행한다. 설치기의 target upsert와 `Register-ScheduledTask -Force`
덕분에 데이터 삭제 없이 마이그레이션된다.

## 7. 오류 처리와 안전성

- 어느 자산이든 다운로드·checksum 검증에 실패하면 예약 작업과 기존 설치를 변경하지
  않는다.
- helper가 sibling shim을 찾지 못하거나 실행하지 못하면 0이 아닌 결과를 Task
  Scheduler에 반환한다.
- helper와 child는 token이나 endpoint를 command line에 넣지 않는다.
- 예약 작업은 기존과 같이 사용자 SID와 최소 권한을 사용한다.
- updater의 다중 파일 교체는 각 파일의 기존 Windows `.old` rename·복구 패턴을
  재사용하며, main shim을 실행 불능 상태로 남기지 않는다.
- `docker compose`, 서버 DB, 원본 Claude/Codex 로그에는 변경이 없다.

## 8. 검증

### 8.1 Rust 단위·계약 테스트

- Windows 작업 XML command가 main shim이 아니라 helper를 가리킨다.
- trigger가 `PT5M`, principal이 `InteractiveToken`·`LeastPrivilege`를 유지한다.
- helper가 sibling shim에 `collect --quiet`와 `CREATE_NO_WINDOW`를 사용한다.
- helper가 child 종료 코드를 전파한다.
- helper 부재·spawn 실패가 성공으로 처리되지 않는다.

### 8.2 PowerShell 생성기 테스트

- 두 Windows 자산을 모두 다운로드하고 각각 checksum을 확인한다.
- 검증 완료 전에 target·PATH·daemon을 변경하지 않는다.
- 마지막 target 제거에만 helper가 삭제된다.

### 8.3 Windows CI

- main shim PE subsystem은 `Windows CUI(3)`다.
- background helper PE subsystem은 `Windows GUI(2)`다.
- 생성된 installer와 uninstaller를 PowerShell parser로 검사한다.
- installer E2E에서 helper 설치와 ACL을 확인한다.
- 등록된 `toard-collect` XML의 action이 helper를 가리키는지 확인한다.
- 예약 작업을 수동 시작하고 완료 결과가 성공인지 확인한다.
- 마지막 target 제거 후 작업과 helper가 모두 사라지는지 확인한다.

창의 시각적 부재는 headless CI에서 직접 관찰할 수 없으므로, GUI subsystem과 child
creation flag라는 두 Windows 실행 계약을 각각 검사해 회귀를 막는다.

## 9. 완료 기준

- 새 Windows 연결 명령 실행 후 `toard-collect`가 helper를 5분마다 실행한다.
- 예약 작업 실행 동안 콘솔·PowerShell 창이 사용자 화면에 나타나지 않는다.
- 수동 `toard-shim` CLI 출력과 종료 코드가 기존과 동일하다.
- Windows installer lifecycle, Rust test·clippy·release build가 통과한다.
- macOS·Linux shim build와 installer lifecycle에 회귀가 없다.
