# Headless shim 제어 설계

- 상태: 구현 승인
- 작성일: 2026-07-24
- 대상: 설정의 컴퓨터 제어, 히스토리 수집 정책, 즉시 수집·진단, shim 주기 동기화

## 1. 결정 요약

브라우저가 `127.0.0.1`의 shim을 직접 호출하는 흐름을 기본 UI에서 제거한다. 각 shim은 기존 ingest token으로 자기 toard 서버에 outbound HTTPS 요청을 보내고 다음 두 종류의 상태를 동기화한다.

- desired state: 히스토리 수집 ON/OFF처럼 지속되는 설정
- command: 지금 수집, 진단처럼 한 번 실행하는 작업

서버에 저장된 desired state와 shim이 보고한 applied state를 분리한다. 웹에서 값을 저장했다는 이유만으로 적용 완료로 표시하지 않으며, shim 보고 전에는 `적용 대기`로 표시한다.

## 2. 목표

- Chrome·Safari·Firefox에서 localhost popup 없이 컴퓨터 설정을 제어한다.
- 히스토리 수집 ON/OFF를 기기·ingest token별로 적용한다.
- `collect`, `doctor`만 원격 실행한다.
- 오프라인 기기에는 만료 가능한 작업을 대기시키고 재연결 후 한 번만 실행한다.
- 다중 target의 자격 증명, 정책, 결과를 서로 격리한다.
- 토큰, 원문 로그, 로컬 경로, doctor 출력은 서버에 보고하지 않는다.
- 기존 로컬 CLI와 loopback bridge는 복구 경로로 유지한다.

## 3. 비목표

- 임의 셸 명령
- 원격 파일 탐색
- V1 원격 shim 업데이트
- 서버에서 수집 원문 또는 doctor 원문 조회
- WebSocket 상시 연결
- 기존 target의 로컬 수집 정책을 첫 동기화에서 임의로 변경

## 4. 제어 흐름

### 4.1 지속 설정

1. 사용자가 기기 행에서 히스토리 수집을 변경한다.
2. 서버는 `generation`을 증가시키고 desired content mode와 활성화 시각을 저장한다.
3. shim의 다음 주기 수집이 시작되기 전에 target별 `/v1/device-control/sync`를 호출한다.
4. shim은 desired state를 target state 디렉터리에 원자적으로 저장한다.
5. 바로 이어지는 수집부터 로컬 credentials보다 해당 target의 remote override를 우선한다. 따라서 OFF가 대기 중이면 이전 정책으로 한 회 더 수집하지 않는다.
6. shim은 수집 후 적용한 generation과 실제 content mode를 다시 sync한다.
7. UI는 desired와 applied가 같을 때만 `적용됨`으로 표시한다.

첫 sync에서 정책 레코드가 없으면 서버는 shim이 보고한 현재 로컬 설정을 desired state의 초기값으로 채택한다. 따라서 업그레이드가 기존 히스토리 수집을 끄거나 켜지 않는다.

### 4.2 일회성 작업

1. 웹은 사용자가 소유한 `(ingest_token_id, device_fingerprint)`에 command를 생성한다.
2. sync는 만료되지 않은 pending command를 원자적으로 claim한다.
3. shim은 allow-list의 `collect` 또는 `doctor`만 처리한다. `doctor`는 즉시 실행하고 `collect`는 바로 이어지는 정기 수집의 실제 target 결과로 완료한다.
4. shim은 command ID, 성공/실패, 제한된 error code만 로컬 state에 저장한다. 별도 중첩 collect를 실행하지 않는다.
5. 수집 후 sync에서 결과를 보고하고 서버는 완료 상태로 전환한다.
6. 같은 command ID는 재수신해도 다시 실행하지 않는다.

## 5. 데이터 모델

### `device_control_policies`

- 사용자, ingest token, device fingerprint
- monotonically increasing `generation`
- `desired_content_mode`: `off | server_v1`, 기존 설치의 첫 sync 보존용 `e2ee_v1`
- `desired_content_since`
- 생성·수정 시각과 수정 사용자

### `device_control_observations`

- applied generation과 실제 content mode
- host, shim version, daemon active
- 마지막 sync 시각과 제한된 error code

### `device_control_commands`

- `collect | doctor`
- `pending | claimed | succeeded | failed | expired`
- 생성·claim·완료·만료 시각
- 결과는 제한된 error code만 저장
- 만료 시각이 지난 active command는 조회 시에도 `expired`로 취급해 오프라인 기기에서 재시도를 막지 않음

## 6. API

### shim ingest-token 인증

`POST /api/v1/device-control/sync`

요청:

- protocol version
- device fingerprint, host, shim version
- target에 적용된 generation과 content mode
- daemon active
- 이전 command 결과 목록

응답:

- desired generation, content mode, content since
- claim된 `collect | doctor` command 목록
- 다음 동기화 권장 초

요청·응답은 `Cache-Control: no-store`이며 닫힌 필드 집합과 크기 제한을 적용한다.

### 로그인 세션 인증

설정 UI의 server action은 다음 작업만 수행한다.

- 소유 기기의 desired content mode 변경
- `collect | doctor` command 생성

모든 mutation은 사용자 소유권을 재검증한다.

## 7. shim 상태와 적용

target별 `~/.toard/targets/<target-id>/state/device-control.json`에 다음만 저장한다.

- applied generation
- content mode와 content since
- 최근 실행한 command ID
- 아직 서버에 보고하지 못한 command 결과

ingest token은 기존 credentials에서만 읽으며 control state에 복사하지 않는다. remote override는 해당 target의 인메모리 credentials에만 합성한다.

## 8. 보안 경계

- 서버는 고정 enum 외 명령을 저장하거나 전송할 수 없다.
- shim도 고정 enum 외 명령을 파싱 단계에서 거부한다.
- command는 사용자·token·device에 결합하고 기본 10분 후 만료한다.
- claim lease가 만료돼 재전송되더라도 shim의 완료 ID가 중복 실행을 막는다.
- doctor stdout/stderr와 수집 로그를 서버에 보내지 않는다.
- doctor 결과는 token, endpoint, scheduler, collection stale 등 고정된 사유 코드만 보고한다.
- 히스토리 ON은 UI에 명확한 동의 문구와 적용 대기 상태를 표시한다.
- OFF는 다음 sync에서 우선 적용되며, 서버 장애 시 마지막 적용 상태를 유지한다.
- 한 target의 sync 실패가 다른 target의 수집·정책·cursor를 막지 않는다.

## 9. UX

기기 행은 다음을 표시한다.

- 히스토리: `켜짐`, `꺼짐`, `적용 대기`
- 연결: `온라인`, `지연`, `아직 headless 제어 미보고`
- 최근 작업: `대기`, `실행 중`, `완료`, `실패`
- hostname은 표시용이며 기기 행과 제어 소유권은 `(ingest token, device fingerprint)`로 구분한다.

기본 설정 화면에서는 `로컬 shim 연결` 카드를 제거한다. 로컬 CLI와 bridge는 README의 고급 복구 절차에 남긴다.

## 10. 단계적 출시

1. DB·API·shim sync와 적용 상태
2. 설정 UI에서 content ON/OFF
3. collect·doctor command
4. 실사용 검증 후 loopback 기본 UI 제거
5. 원격 업데이트는 별도 보안 설계 후 추가
