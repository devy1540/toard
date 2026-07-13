# Windows 주기 수집 스케줄러 설계

## 목적

Windows에서도 Claude/Codex CLI 실행 여부와 관계없이 toard 수집이 주기적으로 실행되게 한다. 서명된 설치 패키지는 만들지 않되, 설치·제거 시 UAC 승인을 받아 현재 로그인한 사용자의 Windows Task Scheduler에 toard 전용 작업만 등록한다.

## 결정

- Rust shim의 기존 `toard-shim daemon install|status|uninstall` 인터페이스를 Windows까지 확장한다.
- 등록·제거는 Windows 기본 제공 PowerShell `ScheduledTasks` 모듈을 사용하고, 상태 조회는 `schtasks.exe /Query /XML`을 사용한다.
- 예약 작업 이름은 `toard-collect`로 고정한다.
- 기본 300초 간격을 Windows의 분 단위 반복 주기로 변환한다. 60초 미만은 기존 CLI 검증에서 거부하고, 나머지는 분 단위로 올림한다.
- 실행 명령은 설치된 `toard-shim.exe collect --quiet`이다.
- 등록·제거 때는 `Start-Process -Verb RunAs`로 UAC 승인을 요청한다.
- UAC를 다른 관리자 계정으로 승인해도 실행 사용자가 바뀌지 않도록, 권한 상승 전 현재 사용자의 SID를 구해 작업 Principal에 명시한다.
- 작업은 `InteractiveToken`과 `LeastPrivilege`로 실행한다. 비밀번호나 토큰은 작업 정의에 저장하지 않는다.

## 동작

### 설치

`toard-shim daemon install`은 현재 사용자 SID를 읽은 뒤 UAC를 요청한다. 승인된 PowerShell은 Task Scheduler XML을 `Register-ScheduledTask -Force`로 멱등 등록한다. PowerShell 설치기는 credentials와 PATH를 저장한 뒤 daemon을 등록하고 doctor를 실행한다. 권한 승인이 취소되거나 daemon 등록·doctor가 실패하면 성공 문구를 출력하지 않는다.

### 상태 확인

`toard-shim daemon status`와 doctor는 `schtasks /Query /XML`로 작업을 조회한다. 작업이 없으면 미등록, XML의 `Enabled`가 false면 비활성, 그 외에는 활성으로 표시한다. 반복 간격은 `PTnM` 값을 초 단위로 변환해 기존 `State::Installed` 계약에 전달한다.

### 제거

`toard-shim daemon uninstall`은 UAC 승인 후 `Unregister-ScheduledTask`로 `toard-collect` 작업만 제거한다. 작업이 이미 없어도 성공으로 처리한다. PowerShell 제거기는 바이너리를 지우기 전에 daemon 제거를 호출하며, 권한 승인이 취소되면 바이너리를 남긴 채 실패한다.

## 오류 처리와 안전성

- UAC 취소, PowerShell 실행 실패, 작업 등록·제거 실패는 비정상 종료로 반환하고 성공 메시지를 출력하지 않는다.
- 작업 이름을 고정해 다른 예약 작업을 조회하거나 삭제하지 않는다.
- 토큰은 예약 작업 명령에 넣지 않는다. shim은 실행 시 `%USERPROFILE%\.toard\credentials`에서 읽는다.
- 예약 작업은 권한 상승 전 확인한 현재 사용자의 SID, `InteractiveToken`, `LeastPrivilege` 조합으로 등록한다. 따라서 사용자가 로그인한 동안에만 제한 권한으로 실행된다.
- Windows 외 macOS launchd와 Linux systemd/cron 동작은 변경하지 않는다.

## 테스트

- Windows 등록 스크립트에 고정 작업명, 5분 주기, 현재 사용자 SID, `InteractiveToken`, `LeastPrivilege`, XML 이스케이프된 shim 경로가 포함되는지 단위 테스트한다.
- UAC 자식 PowerShell에 전달하는 `EncodedCommand`가 UTF-16LE Base64 계약을 따르는지 단위 테스트한다.
- Task Scheduler XML의 활성·비활성·간격과 미등록 상태를 순수 함수로 테스트한다.
- PowerShell 설치기가 daemon 등록 성공을 확인한 뒤 doctor와 완료 문구로 진행하는지 테스트한다.
- PowerShell 제거기가 바이너리 삭제 전에 daemon 제거를 호출하는지 테스트한다.
- macOS에서 전체 Rust·웹 테스트와 clippy/typecheck를 실행하고, PR의 `windows-latest`에서 생성된 PowerShell 파싱과 Windows 네이티브 Rust 테스트·빌드를 실행한다.
