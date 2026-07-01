import path from "node:path";
import type { NextConfig } from "next";

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
