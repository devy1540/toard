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

## 지원 버전

1.0 이전이므로 **main 브랜치 최신 상태**만 지원합니다.
