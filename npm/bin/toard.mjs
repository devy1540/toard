#!/usr/bin/env node
// npx @toard/shim — 현재 OS/arch 를 감지해 GitHub Release 바이너리를
// ~/.toard/bin/{claude,codex} 로 설치한다 (install.sh 의 npx 등가물).
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = process.env.TOARD_REPO ?? "devy1540/toard";

const TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) {
  console.error(`toard: 지원하지 않는 플랫폼입니다: ${key}`);
  console.error(`  지원: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

const binDir = process.env.TOARD_BIN_DIR ?? join(homedir(), ".toard", "bin");
const url = `https://github.com/${REPO}/releases/latest/download/toard-shim-${target}`;

console.log(`toard: ${target} 바이너리 다운로드 중…`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`toard: 다운로드 실패 (HTTP ${res.status})\n  ${url}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());

mkdirSync(binDir, { recursive: true });
const claude = join(binDir, "claude");
writeFileSync(claude, buf, { mode: 0o755 });
chmodSync(claude, 0o755);

const codex = join(binDir, "codex");
rmSync(codex, { force: true });
symlinkSync(claude, codex);

console.log(`toard: 설치 완료 → ${claude}, ${codex}`);
console.log("");
console.log("PATH 에 추가하세요 (진짜 claude 보다 앞서야 함):");
console.log(`  export PATH="${binDir}:$PATH"`);
console.log("");
console.log("자격 증명 → ~/.toard/credentials:");
console.log("  agent_key=<ingest_token>");
console.log("  endpoint=https://toard.example.com/api");
