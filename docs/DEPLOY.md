# 배포 (Docker · Kubernetes · Helm)

toard 서버(Next.js + Postgres, ClickHouse 옵트인)를 컨테이너로 올리는 방법. 수집(OTLP)을 앱이
직수신하므로 무중단 롤링 배포를 전제로 설계했다(ADR-001).

## 이미지

멀티 타깃 `Dockerfile` — 두 이미지:

| 타깃 | 용도 | 실행 |
|---|---|---|
| `runner` | Next.js standalone 앱 | `node apps/web/server.js` |
| `migrator` | 마이그레이션·시드 | `pnpm migrate` / `pnpm seed` |

```bash
docker build --target runner   -t REG/toard:TAG .
docker build --target migrator  -t REG/toard-migrate:TAG .
docker push REG/toard:TAG && docker push REG/toard-migrate:TAG
```

헬스: `GET /api/health`(liveness, 무의존) · `GET /api/ready`(readiness, DB ping).

## 1) Docker Compose (올인원 · 자가호스팅/데모)

앱 + Postgres + 마이그레이션을 한 번에. `.env` 없이 환경변수만으로도 기동:

```bash
AUTH_SECRET=$(openssl rand -base64 33) docker compose up -d --build
# → http://localhost:3000  (PORT 로 변경 가능)
```

- `migrate` 서비스가 Postgres 준비 후 스키마를 맞추고(멱등) 종료 → 그다음 `app` 기동.
- **최초 admin id/pw**(선택):
  ```bash
  BOOTSTRAP_ADMIN_EMAIL=you@corp.com BOOTSTRAP_ADMIN_PASSWORD='...' \
    docker compose --profile seed run --rm seed
  ```
- **ClickHouse 모드**(선택): `STORAGE_BACKEND=clickhouse CLICKHOUSE_URL=http://clickhouse:8123 docker compose --profile clickhouse up -d --build`
- **외부 DB**: `postgres` 서비스를 빼고 `DATABASE_URL` 을 외부 DB 로 지정.

주요 변수: `AUTH_SECRET`(필수) · `POSTGRES_PASSWORD` · `AUTH_MODE`(oauth|open) · `ALLOWED_EMAIL_DOMAINS` · `AUTH_GITHUB_ID/SECRET` · `CRON_SECRET` · `PORT`.

## 2) Kubernetes (kustomize · raw 매니페스트)

`k8s/` — Namespace·ConfigMap·Secret·Postgres(StatefulSet)·app(Deployment)·Service·Ingress.

```bash
cp k8s/secret.example.yaml k8s/secret.yaml   # 값 채우기 (gitignored)
cd k8s && kustomize edit set image toard=REG/toard:TAG toard-migrate=REG/toard-migrate:TAG && cd -
kubectl apply -k k8s/
```

- 마이그레이션은 **앱 파드 initContainer**(`migrate`)가 처리 — 스키마 보장 후 앱 기동. node-pg-migrate
  락으로 멀티파드 안전. `k8s/migrate-job.yaml` 은 선택(CI·수동·시드)이라 기본 kustomization 에서 제외.
- 외부 관리형 DB: `postgres.yaml` 을 `kustomization.yaml` 에서 빼고 Secret 의 `DATABASE_URL` 만 외부로.
- 접속: `kubectl -n toard port-forward svc/toard-app 3000:80` 또는 Ingress(host·TLS 조정).

## 3) Helm

`helm/toard` — values 로 튜닝. GitOps/ArgoCD·다중 환경에 적합.

```bash
helm install toard ./helm/toard \
  --namespace toard --create-namespace \
  --set image.app.repository=REG/toard --set image.app.tag=TAG \
  --set image.migrate.repository=REG/toard-migrate --set image.migrate.tag=TAG \
  --set secrets.authSecret=$(openssl rand -base64 33) \
  --set postgres.auth.password=$(openssl rand -hex 16)
```

- `secrets.authSecret` 미설정 시 렌더가 실패(가드). 프로덕션은 `secrets.existingSecret` 로 외부 시크릿 권장.
- `postgres.enabled=false` + `secrets.databaseUrl=...` → 외부 DB.
- `migrate.seedOnInstall=true` + `secrets.bootstrapAdmin.*` → 최초 설치 시 providers·admin 시드(post-install 훅).
- `ingress.enabled=true --set ingress.host=toard.corp.com` → Ingress.
- 업그레이드: `helm upgrade toard ./helm/toard ...` — 앱 initContainer 가 마이그레이션을 멱등 적용.

## 무중단 배포 노트 (ADR-001)

- Deployment `RollingUpdate maxUnavailable=0, maxSurge=1` — 항상 최소 replica 유지.
- `readinessProbe=/api/ready`(DB 포함) 로 준비된 파드만 트래픽 수신, `livenessProbe=/api/health`(DB 무관)로 재시작 루프 방지.
- 종료 시 `preStop sleep` + `terminationGracePeriodSeconds` 로 in-flight OTLP 수집을 드레인.
- **스키마 변경**은 파괴적 변경을 한 번에 넣지 말 것 — 아래 expand→contract 절.
- cron(`sync-pricing`)은 배포 플랫폼 스케줄러로 별도 등록(README 스케줄러 절).

## 스키마 마이그레이션 (expand → contract)

무중단 롤링 중엔 **구/신 앱 파드가 잠깐 공존**한다. 새 파드의 `migrate` initContainer 가 스키마를
먼저 올리므로, 그 시점 DB 는 "신 스키마"인데 구 파드(구 코드)가 아직 돈다. 따라서 **모든
마이그레이션은 현재 돌고 있는(구) 코드와 하위호환**이어야 한다. `migrations/` 는 forward-only
(node-pg-migrate) — 파괴적 변경은 여러 배포에 걸쳐 나눈다.

| 변경 | 방법 |
|---|---|
| **컬럼 추가** | nullable 로 추가(1단계). 구 코드 무시, 신 코드가 사용 — 안전. |
| **이름/타입 변경** | ①새 컬럼 추가+신 코드 dual-write ②backfill ③다음 배포에서 구 컬럼 DROP. |
| **NOT NULL 추가** | ①nullable 로 추가+신 코드가 항상 기록 ②backfill 로 NULL 제거 ③이후 배포에서 `SET NOT NULL`. |
| **삭제/제약 제거** | 항상 **마지막(contract)** — 구 코드가 완전히 빠진 뒤. |
| **인덱스** | 대량 테이블은 `CREATE INDEX CONCURRENTLY`. 단 node-pg-migrate 는 마이그레이션을 트랜잭션으로 감싸므로 CONCURRENTLY 는 해당 파일을 트랜잭션 밖에서 실행하도록 분리. |

파괴적 변경이 불가피하면 replicas 를 잠깐 1 로 줄여 순단을 감수하거나 유지보수 창을 잡는다.
