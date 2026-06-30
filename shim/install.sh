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
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

echo "toard shim 설치 → ${target} (${VERSION})"
mkdir -p "$BIN_DIR"
tmp=$(mktemp)
curl -fSL "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/claude"
ln -sf "$BIN_DIR/claude" "$BIN_DIR/codex"

echo "설치 완료: $BIN_DIR/{claude,codex}"
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
