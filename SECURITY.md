# 보안 정책 (Security Policy)

toard 는 인증 토큰·사용자 계정·사용량 데이터를 다루는 셀프호스팅 대시보드입니다. 취약점 제보를 환영합니다.

## 취약점 신고

**공개 이슈로 올리지 마세요.** 대신 GitHub 비공개 취약점 신고를 사용해 주세요:

- [Report a vulnerability](https://github.com/devy1540/toard/security/advisories/new) (GitHub Security Advisories, 비공개)

신고 시 포함해 주시면 좋은 것: 영향 범위(어떤 데이터/권한이 노출되는지), 재현 절차, 영향받는 버전/커밋.

## 응답 절차

- **7일 이내** 1차 응답(접수 확인·심각도 판단)을 목표로 합니다.
- 수정이 확정되면 패치 릴리스와 함께 advisory 를 공개하고, 제보자를 크레딧합니다(원치 않으면 익명 처리).

## 특히 관심 있는 영역

- ingest 토큰 인증 우회 (`/api/v1/logs` · `/api/v1/events`) — 이벤트의 타 사용자 귀속 포함
- 세션/권한 상승 (member → admin), `AUTH_MODE`·credentials 로그인 우회
- 프롬프트/PII 가 `raw_events` 등 서버 저장소에 남는 경로 (설계상 수신 최초 단계에서 제거되어야 함)
- SQL/쿼리 주입 (Postgres·ClickHouse 백엔드), cron 엔드포인트 인증 우회
- shim 설치 스크립트·바이너리 배포 경로의 무결성 문제
- shim loopback bridge의 등록되지 않은 origin 접근, target 경계 우회, 세션 인증 우회

## shim loopback bridge 보호 모델

- 설정 UI용 bridge는 고정 loopback 주소 `127.0.0.1:38473`에만 bind하고 외부 인터페이스에서는 수신하지 않는다.
- 요청 `Origin`은 설치 때 target에 기록한 실제 UI origin과 정확히 일치해야 한다. 브라우저는 전체 target ID도 함께 보내며, 와일드카드 CORS를 사용하지 않는다.
- 작업 요청은 origin과 target ID에 함께 결합된 10분짜리 메모리 세션을 요구한다. ingest token·credentials·endpoint·명령 출력·원문 로그는 브라우저에 반환하지 않는다.
- 브라우저 종류와 무관하게 사용자 클릭으로 loopback helper 창을 먼저 연다. helper는 `event.source === window.opener`와 저장된 UI origin을 모두 확인하고, target에 결합된 30초짜리 일회 capability를 동일-origin 요청의 Authorization header로 한 번만 사용한다. capability는 URL이나 원래 UI에 전달하지 않는다. helper 창이 즉시 차단된 경우에만 기존 CORS/Private Network Access 직접 연결을 폴백으로 사용한다.
- helper 응답은 `default-src 'none'`, `connect-src 'self'`, nonce 기반 script, `frame-ancestors 'none'` CSP를 적용하고 작업 후 자동으로 닫힌다. 원래 UI도 helper 창 객체·loopback origin·요청 nonce를 모두 확인한 결과만 수용한다.
- bridge 내부 ping·종료에는 브라우저 세션과 분리된 0600 로컬 secret을 사용한다. 업데이트 바이너리는 기존과 동일하게 릴리스 `SHA256SUMS` 검증을 통과해야 교체된다.
- 이 경계는 등록된 toard origin이 제공하는 JavaScript 자체가 신뢰된다는 전제다. 해당 서버의 XSS나 웹 배포 권한 침해까지 격리하지는 않는다.
- loopback TCP는 OS 계정별 IPC가 아니므로 공유 멀티유저 호스트에서는 다른 로컬 계정도 포트에 접근할 수 있다. 그런 환경에서는 bridge를 실행하지 않고 수동 CLI를 사용한다.

## 프롬프트 히스토리 보호 모델

- 본문 수집은 사용자 opt-in이며 신규 본문은 서버가 DB에 쓰기 전에 `managed_v1`으로 암호화한다. 레코드별 DEK를 사용자별 UCK가 감싸고, UCK는 설치에 설정한 KMS·Transit·local KEK로 감싼다.
- 일반 관리자와 다른 사용자는 RLS 때문에 타 사용자의 본문 행과 평문을 읽지 못한다. DB superuser는 ciphertext와 wrapper를 볼 수 있지만 DB dump만으로는 평문을 복구할 수 없다.
- DB와 KMS·Transit·local KEK 권한을 함께 가진 서버 운영자는 앱 복호화 경로를 실행할 수 있다. 따라서 신규 `managed_v1`은 DB 단독 유출을 방어하는 서버 관리형 암호화이며 E2EE가 아니다.
- provider canary, UCK unwrap, 레코드 암호화 또는 저장이 실패하면 본문을 쓰지 않고 content cursor도 갱신하지 않는다.
- 신규 E2EE setup/activation endpoint는 `410 E2EE_SETUP_RETIRED`로 닫혀 있다. 기존 `e2ee_v1` ciphertext나 blocked migration이 있는 계정에만 recovery/migration 호환 API를 유지하며 자동 삭제하지 않는다.
- `server_v1`은 `managed_v1` 전환을 위한 레거시 경로다. 전체 레거시 0건, `TOARD_LEGACY_BACKUP_RETENTION_DAYS` 경과, 관리자의 백업·WAL·스냅샷 폐기 확인이 모두 끝나기 전에는 기존 KEK를 제거하지 않는다. legacy가 남았는데 KEK가 없으면 readiness가 실패한다.
- 기존 E2EE 기록은 서버가 제공하는 악성 JavaScript나 로컬 기기 침해까지 보호하지 않는다. 복구·이전 전에는 Recovery Kit와 기존 기기 키를 잃으면 복호화할 수 없다.

신규 서버 관리형 암호화와 레거시 전환 절차는 [본문 암호화 운영 런북](docs/content-encryption-runbook.md)을, 기존 E2EE 복구 조건은 [레거시 E2EE 운영 런북](docs/e2ee-prompt-history-runbook.md)을 참고한다.

## MFA 보호 모델

- 자체 이메일/비밀번호 로그인 MFA와 `내 히스토리` 잠금은 사용자가 각각 켤 수 있다. OAuth 로그인에는 TOARD의 로그인 MFA를 중복 적용하지 않지만 히스토리 잠금은 동일하게 적용할 수 있다.
- 패스키 등록과 인증은 WebAuthn RP ID·origin·일회용 challenge를 검증하고 사용자 검증을 필수로 요구한다. challenge는 5분 안에 한 번만 사용할 수 있다.
- 서버에는 credential public key, counter, transport와 백업 상태만 저장한다. 개인키와 생체정보는 Apple 암호 앱·Google Password Manager·Windows Hello 같은 사용자 credential provider를 벗어나지 않는다.
- 비밀번호 확인 뒤 패스키 인증으로 넘어갈 때 비밀번호를 클라이언트 상태에 보관하지 않는다. 등록된 패스키가 없으면 보호 정책을 켤 수 없다.
- 히스토리 잠금 해제 쿠키는 HttpOnly, SameSite=Strict이며 30분 후 만료된다. 현재 로그인 세션 ID·사용자 ID·MFA 설정 버전에 서명되어 재로그인이나 정책 변경 시 무효화되고 대시보드 로그아웃 때 삭제된다.
- 보호가 켜진 히스토리는 서버 렌더링 목록·상세뿐 아니라 `/api/content/history/*`에서도 같은 검사를 통과해야 한다.

## 지원 버전

| 버전 | 지원 여부 |
|---|---|
| 최신 공개 `0.0.x` 릴리스 | 지원 |
| `main` 브랜치 개발 상태 | 지원 버전 아님 |
| 과거 `v*` 릴리스 계열 | 지원 종료 |
