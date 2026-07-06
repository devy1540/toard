#!/bin/sh
# toard shim 설치: OS/arch 자동 감지 → GitHub Release 바이너리 다운로드 → ~/.toard/bin
#
#   curl -fsSL https://github.com/devy1540/toard/releases/latest/download/install.sh | sh
#
# 환경변수: TOARD_BIN_DIR(기본 ~/.toard/bin), TOARD_SHIM_VERSION(기본 latest)
set -e

REPO="devy1540/toard"
BIN_DIR="${TOARD_BIN_DIR:-$HOME/.toard/bin}"
VERSION="${TOARD_SHIM_VERSION:-latest}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os_t="apple-darwin" ;;
  Linux)  os_t="unknown-linux-gnu" ;;
  *) echo "지원하지 않는 OS: $os (darwin/linux 만 지원)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64)  arch_t="x86_64" ;;
  arm64|aarch64) arch_t="aarch64" ;;
  *) echo "지원하지 않는 아키텍처: $arch" >&2; exit 1 ;;
esac
target="${arch_t}-${os_t}"
asset="toard-shim-${target}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
  sums_url="https://github.com/${REPO}/releases/latest/download/SHA256SUMS"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  sums_url="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS"
fi

echo "toard shim 설치 → ${target} (${VERSION})"
mkdir -p "$BIN_DIR"
tmp=$(mktemp)
curl -fsSL "$url" -o "$tmp"

# 무결성 검증 — 릴리즈 SHA256SUMS 대조 (공급망/MITM 방지)
sums=$(mktemp)
curl -fsSL "$sums_url" -o "$sums"
expected=$(grep " ${asset}\$" "$sums" | awk '{print $1}')
if [ -z "$expected" ]; then
  echo "체크섬 항목을 찾지 못함: $asset" >&2; rm -f "$tmp" "$sums"; exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
fi
if [ "$expected" != "$actual" ]; then
  echo "체크섬 불일치 — 설치 중단 (expected=$expected got=$actual)" >&2
  rm -f "$tmp" "$sums"; exit 1
fi
rm -f "$sums"

chmod 755 "$tmp"
mv "$tmp" "$BIN_DIR/claude"
ln -sf "$BIN_DIR/claude" "$BIN_DIR/codex"
ln -sf "$BIN_DIR/claude" "$BIN_DIR/toard-shim"

echo "설치 완료: $BIN_DIR/{claude,codex,toard-shim}"

# Claude Desktop·IDE 사용분까지 수집하려면 텔레메트리 env 가 필요한데, 이 앱들은 shim(PATH)을
# 거치지 않는다. 자격증명이 이미 있으면 ~/.claude/settings.json 에 멱등 주입(재설치로도 on 유지).
#   건너뛰기 TOARD_CLAUDE_ENV=0 · 되돌리기 toard-shim claude-env off
if [ -f "$HOME/.toard/credentials" ] && [ "${TOARD_CLAUDE_ENV:-1}" != "0" ]; then
  "$BIN_DIR/toard-shim" claude-env on || echo "※ claude-env 주입 실패 — 나중에 toard-shim claude-env on 으로 재시도" >&2
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "PATH 에 추가하세요 (진짜 claude 보다 앞서야 함):"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
echo ""
echo "자격 증명 설정 → ~/.toard/credentials:"
echo "  agent_key=<ingest_token>"
echo "  endpoint=https://toard.example.com/api"
echo ""
echo "설정 후 진단: toard-shim doctor"
