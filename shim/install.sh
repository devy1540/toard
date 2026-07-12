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
  *) echo "지원하지 않는 OS: $os (darwin/linux 만 지원 — Windows 는 'npx @toard/shim' 사용)" >&2; exit 1 ;;
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

# 사용량 수집은 트랜스크립트 pull(toard-shim collect)로 자동 — Desktop·IDE·CLI 구분 없이 파일만
# 있으면 재시작·env 주입 없이 수집된다(docs/design-usage-pull). OTLP push 는 experimental 로 강등돼
# claude-env(settings.json OTEL 주입)는 더 이상 설치 시 자동 실행하지 않는다.

# 주기 수집 데몬(opt-in) — Desktop/IDE 처럼 PATH 를 안 거치는 사용도 주기 간격 안에 수집.
# 등록물: macOS=~/Library/LaunchAgents/dev.toard.collect.plist, Linux=systemd user timer(폴백 crontab).
# 언제든 `toard-shim daemon uninstall` 로 제거. 자동화: TOARD_INSTALL_DAEMON=1(등록)/0(건너뜀).
echo ""
case "${TOARD_INSTALL_DAEMON:-}" in
  1) "$BIN_DIR/toard-shim" daemon install || true ;;
  0) echo "주기 수집 데몬 건너뜀 (TOARD_INSTALL_DAEMON=0) — 나중에: toard-shim daemon install" ;;
  *)
    printf "주기 수집 데몬을 등록할까요? 5분마다 사용량을 자동 수집합니다 [Y/n] "
    if read -r ans </dev/tty 2>/dev/null; then
      case "$ans" in
        n|N|no|NO) echo "  건너뜀 — 나중에 등록: toard-shim daemon install" ;;
        *) "$BIN_DIR/toard-shim" daemon install || true ;;
      esac
    else
      echo ""
      echo "  (비대화형 설치 — 데몬 미등록. 등록: toard-shim daemon install, 자동화: TOARD_INSTALL_DAEMON=1)"
    fi
    ;;
esac

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
