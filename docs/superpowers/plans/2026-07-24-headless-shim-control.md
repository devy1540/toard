# Headless shim 제어 구현 계획

**Goal:** localhost popup 없이 웹에서 기기별 히스토리 수집 정책과 제한된 shim 작업을 관리한다.

**Architecture:** 로그인 UI는 서버의 desired state와 command queue만 변경한다. shim은 기존 ingest token과 안정적인 device fingerprint로 target별 sync API를 호출하고, 로컬 applied state 및 command 결과를 다시 보고한다.

## Task 1: 계약과 저장소

- [x] device-control migration 작성
- [x] 닫힌 sync DTO parser와 응답 계약 테스트
- [x] 정책 초기화·generation 변경·command claim/result 저장 repository 구현
- [x] ingest token 인증 sync route 구현

## Task 2: shim 동기화

- [x] target별 control state와 protocol 구현
- [x] HTTPS sync client와 제한된 응답 parser 구현
- [x] remote content override를 collect에 합성
- [x] collect·doctor allow-list command 실행 및 결과 영속화
- [x] 한 target 실패가 다른 target을 막지 않는 테스트

## Task 3: 설정 UI

- [x] 세션 인증 device-control server actions 구현
- [x] 기기별 desired/applied/last sync/command 상태 조회
- [x] 히스토리 ON/OFF와 collect·doctor UI 구현
- [x] pending 상태 자동 새로고침
- [x] 기본 LocalShimPanel 제거 및 한·영 번역 갱신

## Task 4: 검증

- [x] migration integration test
- [x] API/repository/UI focused tests
- [x] Rust 전체 테스트와 format/clippy
- [x] web test/typecheck/Next production build
- [x] 임시 로컬 DB에서 sync → desired 변경 → command claim → result report E2E

## Task 5: 출시 전 보완

- [x] 수집 전 control sync로 OFF 정책을 현재 회차부터 적용
- [x] collect command를 중첩 실행하지 않고 실제 정기 수집 결과로 완료
- [x] 만료 command를 조회 시 expired로 처리해 UI 재시도 허용
- [x] 기기 인벤토리를 `(ingest token, fingerprint)`로 식별하고 hostname 충돌 분리
- [x] 최근 control sync 지연과 제한된 doctor 사유 코드 표시
