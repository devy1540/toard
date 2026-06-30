# toard

경량 멀티 프로바이더 AI 사용량 대시보드. 설계 문서: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 구조 (pnpm 모노레포)

```
apps/web                 # Next.js — OTLP/JSON 수신 + 대시보드 + Auth.js
packages/core            # 도메인 타입 + StorageBackend 인터페이스 (의존성 0)
packages/ingest          # OTLP 파싱 · provider 식별 · 정규화 · dedup
packages/pricing         # LiteLLM 비용 엔진 (resolveCost)
packages/storage-postgres# StorageBackend PG 구현
migrations/              # 순수 SQL (node-pg-migrate)
scripts/seed.ts          # providers · admin · dev token · 가격 시드
shim/                    # OTEL shim (Go/Rust — 추후)
```

## 개발 시작

```bash
pnpm install
cp .env.example .env          # AUTH_SECRET, BOOTSTRAP_ADMIN_EMAIL 채우기
pnpm db:up                    # 로컬 Postgres (docker)
pnpm migrate                  # 스키마
pnpm seed                     # providers + admin + dev ingest token (평문 1회 출력)
pnpm dev                      # http://localhost:3000
```

## 수집 테스트 (shim 없이)

```bash
curl -X POST http://localhost:3000/api/v1/logs \
  -H "Authorization: Bearer <seed 가 출력한 토큰>" \
  -H "Content-Type: application/json" \
  --data @fixtures/sample-otlp-logs.json
# → {"inserted":1,"deduped":0}  (재실행 시 deduped:1 — 멱등)
```

## 검증

```bash
pnpm typecheck     # 전 패키지
pnpm test          # pricing 단위 테스트 (resolveCost)
```

## ClickHouse 모드 (옵트인)

중규모 이상에서 이벤트·집계만 ClickHouse 로 (메타·인증은 항상 PG, ADR-003).

```bash
pnpm db:up                              # postgres + clickhouse 함께 기동
STORAGE_BACKEND=clickhouse pnpm dev     # 앱이 CH 백엔드 사용
```

기본 접속값: `CLICKHOUSE_URL=http://localhost:8123` · `CLICKHOUSE_USER/PASSWORD/DB=toard`. 스키마는 `clickhouse/init/` 가 컨테이너 최초 기동 시 자동 로드. 스모크 검증: `pnpm exec tsx scripts/verify-clickhouse.ts`.

## 로그인 (OAuth)

OAuth 자격을 설정하면 실제 로그인이 활성화된다. 미설정 dev 환경은 첫 user 로 폴백(화면 확인용).

```bash
AUTH_SECRET=...                             # openssl rand -base64 33
AUTH_GITHUB_ID=...  AUTH_GITHUB_SECRET=...  # GitHub OAuth App
AUTH_GOOGLE_ID=...  AUTH_GOOGLE_SECRET=...  # Google OAuth Client (선택)
ALLOWED_EMAIL_DOMAINS=day1company.co.kr     # (선택) 허용 이메일 도메인
```

콜백 URL: `http://localhost:3000/api/auth/callback/{github|google}`. 자격이 있는 provider 만 활성화되며, 헤더 우측에 로그인/로그아웃이 표시된다.

## 핵심 결정 (요약)

- **수집:** shim → 앱이 OTLP/JSON 직접 수신(Collector 없음). 무중단 배포 필수 (ADR-001)
- **저장:** Postgres 단일(기본) · ClickHouse 옵트인 — `StorageBackend` 추상화 (ADR-003)
- **비용:** LiteLLM per-million + tiered(200k) + 캐시/fast (ADR-004)
- **인증:** Auth.js + 자체 PG 세션 (ADR-007)
- 자세한 근거·검토 이력은 설계 문서 §2(ADR) 참조.
