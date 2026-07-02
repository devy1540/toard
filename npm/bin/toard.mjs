#!/usr/bin/env node
// npx @toard/shim — 현재 OS/arch 를 감지해 GitHub Release 바이너리를
// ~/.toard/bin/{claude,codex} 로 설치한다 (install.sh 의 npx 등가물).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = process.env.TOARD_REPO ?? "devy1540/toard";

// 패키지 버전으로 릴리스를 고정 — `npx @toard/shim@X.Y.Z` 가 정확히 vX.Y.Z 바이너리를 설치한다.
// 0.0.0(개발 트리) 또는 TOARD_SHIM_VERSION=latest 는 latest 로 폴백.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const rawVersion = process.env.TOARD_SHIM_VERSION ?? (pkg.version && pkg.version !== "0.0.0" ? pkg.version : "latest");
const version = rawVersion === "latest" || rawVersion.startsWith("v") ? rawVersion : `v${rawVersion}`;
const releaseBase =
  version === "latest"
    ? `https://github.com/${REPO}/releases/latest/download`
    : `https://github.com/${REPO}/releases/download/${version}`;

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
const url = `${releaseBase}/toard-shim-${target}`;

console.log(`toard: ${target} 바이너리 다운로드 중… (${version})`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`toard: 다운로드 실패 (HTTP ${res.status})\n  ${url}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());

// 무결성 검증 — 릴리즈 SHA256SUMS 대조 (공급망/MITM 방지)
const sumsRes = await fetch(`${releaseBase}/SHA256SUMS`, {
  redirect: "follow",
});
if (!sumsRes.ok) {
  console.error(`toard: SHA256SUMS 다운로드 실패 (HTTP ${sumsRes.status})`);
  process.exit(1);
}
const sums = await sumsRes.text();
const asset = `toard-shim-${target}`;
const line = sums.split("\n").find((l) => l.trimEnd().endsWith(asset));
const expected = line?.trim().split(/\s+/)[0];
const actual = createHash("sha256").update(buf).digest("hex");
if (!expected || expected !== actual) {
  console.error(`toard: 체크섬 불일치 — 설치 중단 (expected=${expected ?? "(없음)"} got=${actual})`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
const claude = join(binDir, "claude");
writeFileSync(claude, buf, { mode: 0o755 });
chmodSync(claude, 0o755);

const codex = join(binDir, "codex");
rmSync(codex, { force: true });
symlinkSync(claude, codex);

const shimCli = join(binDir, "toard-shim");
rmSync(shimCli, { force: true });
symlinkSync(claude, shimCli);

console.log(`toard: 설치 완료 → ${claude}, ${codex}, ${shimCli}`);
console.log("");
console.log("PATH 에 추가하세요 (진짜 claude 보다 앞서야 함):");
console.log(`  export PATH="${binDir}:$PATH"`);
console.log("");
console.log("자격 증명 → ~/.toard/credentials:");
console.log("  agent_key=<ingest_token>");
console.log("  endpoint=https://toard.example.com/api");
