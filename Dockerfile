# syntax=docker/dockerfile:1
# toard 프로덕션 이미지 (멀티 타깃).
#   --target runner   → Next.js standalone 앱 (기본)
#   --target migrator → 마이그레이션/시드 실행용 (node-pg-migrate · tsx)
#   --target content-admin → 암호화 상태·이전 one-shot 관리 도구
#   --target updater  → Compose 전용 서버 자가 업데이트 agent
# pnpm 모노레포 + Next standalone. bcryptjs/pg 는 순수 JS → alpine(musl) 무리 없음.
ARG NODE_VERSION=22-alpine

# ---- base: pnpm 준비 ----
# corepack 대신 전역 설치 — 런타임(비루트)에 corepack 이 pnpm 을 다운로드하려다 캐시 쓰기 실패하는
# 문제 회피(k8s runAsNonRoot). 빌드 시 이미지에 pnpm 을 박아 런타임 네트워크 의존도 제거.
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@11.15.1
WORKDIR /app

# ---- deps: 워크스페이스 의존성 설치 (매니페스트만 복사 → 캐시 최대화) ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/ingest/package.json ./packages/ingest/
COPY packages/pricing/package.json ./packages/pricing/
COPY packages/storage-postgres/package.json ./packages/storage-postgres/
COPY packages/storage-clickhouse/package.json ./packages/storage-clickhouse/
COPY packages/updater/package.json ./packages/updater/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --config.enable-global-virtual-store=false install --frozen-lockfile

# ---- benchmark: source + deps + production build tools ----
# HTTP SLO 참조 측정은 이 컨테이너 안에서 fixture 준비와 production Next start를 모두 실행한다.
# Compose가 이 stage에 app 1.5 vCPU / 2 GiB 제한을 적용한다.
FROM deps AS benchmark
COPY . .
ENV HOME=/tmp \
    NEXT_TELEMETRY_DISABLED=1
CMD ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600; done"]

# ---- builder: next build → standalone 산출 ----
FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @toard/web build

# ---- runner: 최소 런타임 (standalone) ----
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
# 릴리스 버전 임베드 — docker-publish 가 태그를 주입, /api/v1/version·사이드바가 노출. 미주입=dev(0.0.0)
ARG TOARD_VERSION=""
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_VERSION=${TOARD_VERSION}
# 비루트 실행
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# outputFileTracingRoot=저장소 루트 → standalone 은 apps/web/server.js 및 node_modules 를 루트 기준으로 담음
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
# 컨테이너 헬스체크: readiness(DB 포함). Node 내장 fetch 사용 → curl/wget 불필요.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ---- migrator: 마이그레이션 + 시드 (일회성 Job/init) ----
# deps 스테이지 재사용(node-pg-migrate·tsx·pg·bcryptjs 포함). DATABASE_URL 필수.
#   기본: pnpm migrate   |  시드: command 를 ["pnpm","seed"] 로 오버라이드
FROM deps AS migrator
# 비루트(k8s runAsNonRoot)로 실행돼도 pnpm/node 가 캐시를 쓸 수 있게 쓰기 가능한 HOME.
ENV HOME=/tmp
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY packages/core/ ./packages/core/
CMD ["pnpm", "migrate"]

# ---- content-admin: 암호화 상태·전환 one-shot 관리 도구 ----
# provider secret은 런타임 read-only volume/workload identity로만 주입하며 image layer에 넣지 않는다.
FROM deps AS content-admin
ENV HOME=/tmp \
    NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S toardadmin -u 1001 -G nodejs
COPY . .
USER toardadmin
ENTRYPOINT ["pnpm", "toard-admin"]
CMD ["encryption", "status"]

# ---- updater: Compose 전용 서버 자가 업데이트 agent ----
# Docker socket 권한은 웹앱이 아니라 이 선택 서비스에만 부여한다.
FROM node:${NODE_VERSION} AS updater
WORKDIR /app
ENV NODE_ENV=production \
    TOARD_UPDATER_PORT=3201 \
    TOARD_APP_URL=http://app:3000 \
    TOARD_COMPOSE_PROJECT_DIR=/workspace \
    TOARD_COMPOSE_FILE=docker-compose.yml
RUN apk add --no-cache docker-cli docker-cli-compose
COPY packages/updater ./packages/updater
EXPOSE 3201
CMD ["node", "packages/updater/src/server.mjs"]
