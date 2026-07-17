# 배포 (Docker · Kubernetes · Helm)

toard 서버(Next.js + Postgres, ClickHouse 옵트인)를 컨테이너로 올리는 방법. 수집(OTLP)을 앱이
직수신하므로 무중단 롤링 배포를 전제로 설계했다(ADR-001).

**분리 배치(서버 ↔ 개발자 머신)** — 수집은 push 구조: 각 개발자 머신의 shim 이 서버로 전송하므로
서버는 개발자들이 접근 가능한 주소로 서빙하기만 하면 된다(개발자 → 서버 단방향 HTTPS, 역방향 접속
없음). 토큰이 Bearer 로 전송되므로 공개망은 TLS 필수. 프록시 뒤라 브라우징 URL ≠ 수집 URL 이면
`TOARD_PUBLIC_URL` 로 설치 스니펫용 공개 URL 을 지정한다(미설정 시 요청 host 자동 유추).

## 이미지

멀티 타깃 `Dockerfile` — 운영 이미지 네 개:

| 타깃 | 용도 | 실행 |
|---|---|---|
| `runner` | Next.js standalone 앱 | `node apps/web/server.js` |
| `migrator` | 마이그레이션·시드 | `pnpm migrate` / `pnpm seed` |
| `content-admin` | 암호화 상태·전환 one-shot 도구 | `encryption status` 등 |
| `updater` | Compose 자가 업데이트 agent | `node packages/updater/src/server.mjs` |

CI(`docker-publish.yml`)가 main push·`v*` 태그마다 `ghcr.io/devy1540/toard`,
`ghcr.io/devy1540/toard-migrate`, `ghcr.io/devy1540/toard-content-admin`,
`ghcr.io/devy1540/toard-updater`를 자동 게시한다
(amd64·arm64 멀티아치 — arch 별 네이티브 러너 분리 빌드 후 manifest 병합) — 직접 빌드 없이 pull 로 사용 가능. 자체 레지스트리가 필요하면:

```bash
docker build --target runner   -t REG/toard:TAG .
docker build --target migrator  -t REG/toard-migrate:TAG .
docker build --target content-admin -t REG/toard-content-admin:TAG .
docker build --target updater -t REG/toard-updater:TAG .
docker push REG/toard:TAG && docker push REG/toard-migrate:TAG \
  && docker push REG/toard-content-admin:TAG && docker push REG/toard-updater:TAG
```

헬스: `GET /api/health`(liveness, 무의존) · `GET /api/ready`(readiness, DB ping).

## 1) Docker Compose (올인원 · 자가호스팅/데모)

앱 + Postgres + 마이그레이션을 한 번에. `.env` 없이 환경변수만으로도 기동:

```bash
AUTH_SECRET=$(openssl rand -base64 33) docker compose up -d
# → http://localhost:3000  (PORT 로 변경 가능)
```

- **이미지**: 기본은 GHCR 프리빌트(`ghcr.io/devy1540/toard{,-migrate}`, amd64·arm64 멀티아치)를 pull. `TOARD_TAG` 로 버전 고정(기본 `latest` = main 최신). 소스에서 직접 빌드(미게시 변경 확인 등)는 `--build` 추가.
- **`AUTH_SECRET` 필수**: 미설정 시 compose 가 파싱 단계에서 즉시 에러(안전하지 않은 기본값 없음). `down`/`logs` 등 다른 compose 명령에도 값이 필요하니 `.env` 에 넣어두면 편하다.
- `migrate` 서비스가 Postgres 준비 후 스키마 + baseline(providers·pricing) 을 맞추고(멱등) 종료 → `app` 기동.
- **최초 관리자**: 배포 후 브라우저로 열면 사용자가 0명이라 **`/setup`** 으로 유도된다 → 이메일·비번 직접 입력해 admin 생성(첫 사용자만 admin, 이후 잠김). **노출 전 즉시 설정**할 것.
  - headless(사전 프로비저닝) 대안: `BOOTSTRAP_ADMIN_EMAIL`·`BOOTSTRAP_ADMIN_PASSWORD` env 설정 시 `migrate` 가 admin 도 선생성 → `/setup` 창이 열리지 않음.
- **ClickHouse 모드**(선택): `STORAGE_BACKEND=clickhouse CLICKHOUSE_URL=http://clickhouse:8123 docker compose --profile clickhouse up -d`
- **외부 DB**: `postgres` 서비스를 빼고 `DATABASE_URL` 을 외부 DB 로 지정.

주요 변수: `AUTH_SECRET`(필수) · `POSTGRES_PASSWORD` · `AUTH_MODE`(oauth|open) · `ALLOWED_EMAIL_DOMAINS` · `AUTH_GITHUB_ID/SECRET` · `CRON_SECRET` · `PRICING_AUTO_SYNC`(기본 on) · `PORT`.

### Compose 서버 업데이트 버튼(선택)

관리 화면의 시스템 탭에서 서버 이미지를 업데이트하려면 별도 updater agent 를 켠다. 웹앱 컨테이너에는
Docker socket 을 주지 않고, `updater` 서비스만 제한된 내부 API 로 최신 릴리스를 확인한 뒤
`.env` 의 `TOARD_TAG` 를 백업과 함께 갱신하고, `docker compose pull` →
`docker compose run --rm migrate` → `docker compose up -d app` → health/ready/version 확인을 실행한다.

```bash
TOARD_UPDATER_SECRET=$(openssl rand -base64 33)

# .env 에 저장 권장
TOARD_UPDATER_URL=http://updater:3201
TOARD_UPDATER_SECRET=$TOARD_UPDATER_SECRET

docker compose --profile updater up -d
```

- **Compose 전용**: Helm/Kubernetes 배포는 이미지 태그·릴리스 관리 방식이 달라 이 updater 를 쓰지 않는다.
- **권한 주의**: updater 는 `/var/run/docker.sock` 과 배포 디렉터리를 마운트하므로 호스트 Docker 권한과 `.env` 수정 권한을 가진다. 공개 포트를 열지 않고 Compose 내부 네트워크에서만 앱이 shared secret 으로 호출한다.
- **`.env` 필수**: updater 가 같은 배포 디렉터리에서 compose 를 실행하므로 `AUTH_SECRET` 같은 운영 설정은 `.env` 에 고정해 둔다. 업데이트 시 기존 값은 유지하고 `TOARD_TAG` 만 바꾼다.
- **롤백**: 첫 버전은 자동 롤백을 하지 않는다. 실패하면 updater 가 변경한 `.env` 는 되돌리지만, 이미 재시작된 컨테이너까지 자동으로 롤백하지는 않는다. 운영자는 이전 `TOARD_TAG` 로 되돌린 뒤 `docker compose pull && docker compose up -d` 를 실행한다.
- **과거 가격 revision 호환성**: `v0.15.16`부터 `[effective_at, valid_until)` 가격 구간을 읽는다. 과거 가격 자동 복구가 한 번이라도 revision을 승격한 서버는 `v0.15.15` 이하로 앱만 되돌리지 않는다. `/api/ready`의 `historicalPricingReader.minimumVersion`과 `compatible`을 먼저 확인한다. 로컬 개발 버전 `0.0.0`은 허용된다.

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
- 일반 migration Job은 `migrate → baseline seed → completion marker` 순서로 실행된다. Job 이름, 앱 Pod
  annotation, 앱/Job env, DB marker는 모두 동일한 64자리 release completion ID를 사용한다. 이 ID는
  namespace/release, effective release ID, expected schema, migrator 이미지, DB Secret 이름/key 및 주요 Job
  spec을 SHA-256으로 묶은 비밀이 아닌 배포 식별자다. 별도 Kubernetes Secret을 만들지 않는다.
- Helm CLI에서 `migrate.releaseId=""`이면 `.Release.Revision`이 fallback 입력이다. Argo CD·Flux 같은 GitOps는
  Helm revision이 실제 desired-state 변경과 일치하지 않을 수 있으므로 `migrate.releaseId`를 반드시 지정한다.
  동일 desired state에는 동일 값을 유지하고, 새 배포마다 변경되는 안정적인 Git commit SHA 또는 semver를
  사용한다. migrator에는 `latest` 같은 mutable tag(가변 태그)를 쓰지 말고 digest나 immutable tag를 쓴다.
  같은 desired state의 migration을 force rerun(강제 재실행)하려면 `migrate.releaseId`를 새 값으로 바꾼다.
- `/api/ready`는 새 파드의 deployment ID·completion ID·expected schema와 정확히 일치하는 DB marker가
  생기기 전까지 503이다. 따라서 migrate/seed/marker 중 하나라도 실패하면 새 파드는 트래픽을 받지 않고,
  `maxUnavailable=0`인 기존 파드는 자신의 과거 marker로 계속 ready다. 완료된 Job은 TTL 뒤 정리하지만
  과거 DB marker는 보존한다. Helm 명령도 기다리려면 `--wait --wait-for-jobs`를 쓴다.
- 롤백은 이전 이미지와 이전 `migrate.releaseId`를 포함한 이전 desired state를 그대로 복원한다. 그러면 같은
  completion ID와 보존된 과거 marker를 다시 사용한다. 단 DB migration은 forward-only이므로 이전 앱이
  현재 스키마와 호환될 때만 안전하다. DB 스키마 자체를 자동 downgrade하지 않는다.
- 앱 `DATABASE_URL`을 `toard_app`처럼 marker table SELECT-only 롤로 운영하면 migration/seed/marker Job에는
  owner 연결을 별도 Secret으로 주입한다: `migrate.databaseSecret.name`과 `migrate.databaseSecret.key`.
  비우면 호환성을 위해 앱과 같은 `DATABASE_URL`을 사용하므로 그 연결은 migration owner여야 한다.

## 본문 수집 활성화 (선택 — 프롬프트/응답 저장)

기본은 usage(토큰·비용)만 수집한다. 프롬프트·응답 **본문**까지 저장하려면 아래 둘이 필요하고, 안 하면 기능은 완전히 비활성이다.

**1) 서버 관리형 key provider.** 신규 본문은 설치 전체에서 선택한 KMS/Transit/local provider로 사용자별
UCK를 감싼 `managed_v1`으로 저장한다. provider env, workload identity/secret file, Compose/Helm one-shot
명령과 회전 절차는 [본문 암호화 운영 런북](content-encryption-runbook.md)을 따른다. `TOARD_CONTENT_KEK_B64`는
잔여 `server_v1` 전환에만 사용하고 `serverRecords=0`과 백업 보존 확인 전 제거하지 않는다.

**2) 앱 런타임 롤(RLS 발효).** `prompt_records` 는 소유자 전용 RLS 로 보호된다. 단 **RLS 는 앱이 비-superuser 롤로 접속할 때만 강제**된다(superuser 는 우회). 전용 롤을 만들고 앱 `DATABASE_URL` 만 그 롤로 바꾼다:
```sh
# owner-only (0600) psql input file은 secret manager가 생성한다.
# 이 파일에는 PSQL-quoted app_password 변수와 bootstrap script의 absolute \i 경로만 둔다.
# 비밀번호를 terminal, shell env, process argv, repository에 넣지 않는다.
psql "$ADMIN_DATABASE_URL" -f /secure/bootstrap-app-role.psql
# 이후 앱:  DATABASE_URL=postgres://toard_app:<비밀번호>@host:5432/db
# 마이그레이션·seed 는 계속 관리(슈퍼유저) 롤로.
```
그리고 각 사용자가 shim 에서 `TOARD_SHIM_COLLECT_CONTENT=1` 로 opt-in 하면 본문이 쌓이고, 본인만 `/history` 에서 조회한다.

Compose에서는 migration owner와 앱 role을 다음 순서로 분리한다. URL이나 비밀번호를 터미널 출력·이슈·CI artifact에 남기지 않는다.

```sh
# 1. owner 연결(MIGRATION_DATABASE_URL)로 schema를 먼저 준비한다.
docker compose up -d postgres migrate

# 2. 같은 owner 연결로 앱 role을 생성한다.
# owner-only (0600) psql input file은 secret manager가 생성하며 PSQL-quoted app_password와
# scripts/bootstrap-app-role.sql의 absolute \i 경로만 포함한다. 비밀번호를 argv로 전달하지 않는다.
psql "$MIGRATION_DATABASE_URL" -f /secure/bootstrap-app-role.psql

# 3. APP_DATABASE_URL은 toard_app role로, MIGRATION_DATABASE_URL은 owner로 유지한 뒤 앱을 시작/재시작한다.
docker compose up -d app
```

관리형 본문을 켠 상태에서 `APP_DATABASE_URL`이 superuser 또는 `BYPASSRLS` role이면 `/api/ready`는 503을 반환한다. 관리형 본문을 사용하지 않는 기존 Compose 설치는 두 URL을 설정하지 않아도 기존 기본 연결로 동작한다.

> 일반 관리자 UI와 타 사용자는 RLS 때문에 타 사용자 평문/행을 읽지 못한다. DB superuser는 ciphertext와
> wrapper를 볼 수 있으나 DB dump만으로 평문을 복구할 수 없다. 다만 DB와 KMS/Transit/local KEK 권한을
> 함께 가진 서버 운영자는 앱 복호화 경로를 실행할 수 있으므로 E2EE는 아니다.

신규 E2EE setup/activation endpoint는 `410 E2EE_SETUP_RETIRED`로 차단된다. 기존 `e2ee_v1` 또는 blocked
migration이 남은 계정에 대해서만 recovery wrapper/complete와 managed migration API를 유지하며 자동 삭제는 하지 않는다.
계정이 없거나 계정만 있고 legacy 행이 없는 사용자는 이 API도 body 처리 전에 410으로 종료한다. capability 조회
오류는 `500 E2EE_LEGACY_GATE_FAILED`와 `Cache-Control: no-store`로 fail-closed한다.

## 무중단 배포 노트 (ADR-001)

- Deployment `RollingUpdate maxUnavailable=0, maxSurge=1` — 항상 최소 replica 유지.
- `readinessProbe=/api/ready`(DB 포함) 로 준비된 파드만 트래픽 수신, `livenessProbe=/api/health`(DB 무관)로 재시작 루프 방지.
- 종료 시 `preStop sleep` + `terminationGracePeriodSeconds` 로 in-flight OTLP 수집을 드레인.
- **스키마 변경**은 파괴적 변경을 한 번에 넣지 말 것 — 아래 expand→contract 절.
- cron(`sync-pricing`)은 앱 내장 스케줄러가 일 1회 자동 실행 — 별도 등록 불필요. on/off 는 관리 → 시스템 탭 토글(재시작 불필요), env `PRICING_AUTO_SYNC=off` 는 인프라 킬스위치. replica 가 여럿이면 각자 틱을 돌지만 "오늘 이미 동기화됨" 검사 + UPSERT 멱등이라 무해. 외부 스케줄러(Vercel·GH Actions)를 쓸 때만 별도 등록(README 스케줄러 절).

## 스키마 마이그레이션 (expand → contract)

무중단 롤링 중엔 **구/신 앱 파드가 잠깐 공존**한다. Helm은 release completion ID별 migration Job이
스키마를 먼저 올리고, raw Kubernetes 배포는 새 파드의 `migrate` initContainer가 이를 수행한다.
그 시점 DB 는 "신 스키마"인데 구 파드(구 코드)가 아직 돈다. 따라서 **모든
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
