import path from "node:path";
import { config as loadRootEnv } from "dotenv";
import type { NextConfig } from "next";

// 모노레포 루트의 .env 를 로드 — README 의 `cp .env.example .env`(루트) 절차와 정합.
// 이미 설정된 셸/플랫폼 env·apps/web/.env* 가 우선(dotenv 는 기존 키를 덮지 않음)하므로
// 배포(Docker/K8s, env 직접 주입)에는 영향 없음. @next/env 는 Next 가 앞서 로드한
// 전역 캐시를 반환해 여기서 재호출해도 no-op 이라 dotenv 를 직접 사용한다.
loadRootEnv({ path: path.join(import.meta.dirname, "../../.env") });

const config: NextConfig = {
  // 워크스페이스 패키지를 TS 소스 그대로 트랜스파일 (빌드 단계 불필요)
  transpilePackages: [
    "@toard/core",
    "@toard/ingest",
    "@toard/pricing",
    "@toard/storage-postgres",
  ],
  experimental: {
    optimizePackageImports: ["recharts"],
  },
  // pnpm 모노레포: standalone 이 워크스페이스 밖(루트 node_modules)의 의존성까지 추적하도록
  // 트레이싱 루트를 저장소 루트로 지정 (미지정 시 Docker standalone 에서 런타임 모듈 누락).
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // standalone 단일 이미지 (ADR-001 무중단 배포 — 배포 시 rolling/blue-green 강제)
  output: "standalone",
};

export default config;
