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
  // standalone 단일 이미지 (ADR-001 무중단 배포 — 배포 시 rolling/blue-green 강제)
  output: "standalone",
};

export default config;
