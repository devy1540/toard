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

## 핵심 결정 (요약)

- **수집:** shim → 앱이 OTLP/JSON 직접 수신(Collector 없음). 무중단 배포 필수 (ADR-001)
- **저장:** Postgres 단일(기본) · ClickHouse 옵트인 — `StorageBackend` 추상화 (ADR-003)
- **비용:** LiteLLM per-million + tiered(200k) + 캐시/fast (ADR-004)
- **인증:** Auth.js + 자체 PG 세션 (ADR-007)
- 자세한 근거·검토 이력은 설계 문서 §2(ADR) 참조.
