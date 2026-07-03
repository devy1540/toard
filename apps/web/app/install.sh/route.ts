import { getIngestEndpoint } from "@/lib/public-url";

// toard 가 직접 서빙하는 원클릭 설치 스크립트. endpoint 를 서버가 주입하고, 토큰은 env 로 받는다.
//   curl -fsSL <toard>/install.sh | TOARD_INGEST_TOKEN=tk_... sh
export const dynamic = "force-dynamic";

export async function GET() {
  const endpoint = await getIngestEndpoint();
  return new Response(installScript(endpoint), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function installScript(endpoint: string): string {
  return [
    "#!/bin/sh",
    "# toard shim 원클릭 설치 (toard 서빙). 사용:",
    "#   curl -fsSL <toard>/install.sh | TOARD_INGEST_TOKEN=tk_... sh",
    "set -e",
    'ENDPOINT="${TOARD_INGEST_ENDPOINT:-' + endpoint + '}"',
    'TOKEN="${TOARD_INGEST_TOKEN:-}"',
    'BIN_DIR="${TOARD_BIN_DIR:-$HOME/.toard/bin}"',
    "",
    "# 1) 바이너리 설치(다운로드 + SHA 검증)는 릴리스 install.sh 에 위임",
    "curl -fsSL https://github.com/devy1540/toard/releases/latest/download/install.sh | sh",
    "",
    "# 2) 자격 증명 자동 작성",
    'if [ -n "$TOKEN" ]; then',
    '  mkdir -p "$HOME/.toard"; chmod 700 "$HOME/.toard"',
    "  printf 'agent_key=%s\\nendpoint=%s\\n' \"$TOKEN\" \"$ENDPOINT\" > \"$HOME/.toard/credentials\"",
    '  chmod 600 "$HOME/.toard/credentials"',
    '  echo "자격 증명 작성됨 → ~/.toard/credentials (endpoint=$ENDPOINT)"',
    "else",
    '  echo "※ TOARD_INGEST_TOKEN 미전달 — ~/.toard/credentials 를 직접 설정하세요"',
    "fi",
    "",
    "# 3) PATH 자동 추가 (멱등)",
    'case ":$PATH:" in',
    '  *":$BIN_DIR:"*) ;;',
    "  *)",
    '    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do',
    '      [ -f "$rc" ] || continue',
    "      grep -q 'toard/bin' \"$rc\" 2>/dev/null && continue",
    "      printf '\\nexport PATH=\"%s:$PATH\"  # toard shim\\n' \"$BIN_DIR\" >> \"$rc\"",
    "    done",
    '    echo "PATH 에 $BIN_DIR 추가됨(새 셸부터 적용)."',
    "    ;;",
    "esac",
    "",
    "# 4) 구 릴리스 install.sh 가 toard-shim 링크를 안 만들었으면 보완",
    '[ -e "$BIN_DIR/toard-shim" ] || ln -sf "$BIN_DIR/claude" "$BIN_DIR/toard-shim" 2>/dev/null || true',
    "",
    "# 5) Claude Desktop·IDE 확장 사용분까지 수집 — ~/.claude/settings.json 에 텔레메트리 env 주입",
    "#    (새 세션부터 적용. 건너뛰려면 TOARD_CLAUDE_ENV=0, 되돌리려면 toard-shim claude-env off)",
    'if [ -n "$TOKEN" ] && [ "${TOARD_CLAUDE_ENV:-1}" != "0" ] && [ -x "$BIN_DIR/toard-shim" ]; then',
    '  "$BIN_DIR/toard-shim" claude-env on || echo "※ claude-env 주입 실패 — 나중에 toard-shim claude-env on 으로 재시도"',
    "fi",
    "",
    "# 6) 진단",
    'if [ -x "$BIN_DIR/toard-shim" ]; then',
    '  PATH="$BIN_DIR:$PATH" "$BIN_DIR/toard-shim" doctor || true',
    "fi",
    "echo \"완료 — 새 셸에서 'which claude' 가 \\$BIN_DIR/claude 이면 성공.\"",
    "",
  ].join("\n");
}
