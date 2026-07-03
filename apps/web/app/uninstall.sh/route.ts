// toard shim 제거 스크립트 (install 의 역순). 사용:
//   curl -fsSL <toard>/uninstall.sh | sh
// 진짜 claude/codex 는 건드리지 않고, shim·자격증명·PATH 라인·claude-env(settings.json)·
// codex [otel] 블록만 제거(백업 남김).
export const dynamic = "force-static";

export function GET() {
  return new Response(UNINSTALL, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const UNINSTALL = [
  "#!/bin/sh",
  "# toard shim 제거. 사용: curl -fsSL <toard>/uninstall.sh | sh",
  "set -e",
  'BIN_DIR="${TOARD_BIN_DIR:-$HOME/.toard/bin}"',
  'echo "toard shim 제거 중…"',
  "",
  "# 0) ~/.claude/settings.json 의 toard 관리 텔레메트리 키 제거 (바이너리 삭제 전에 실행해야 가능)",
  '{ [ -x "$BIN_DIR/toard-shim" ] && "$BIN_DIR/toard-shim" claude-env off; } || true',
  "",
  "# 1) shim 바이너리 + 자격 증명 제거 (진짜 claude 는 그대로)",
  'rm -f "$BIN_DIR/claude" "$BIN_DIR/codex" "$BIN_DIR/toard-shim" "$HOME/.toard/credentials"',
  'rm -f "$HOME/.toard/state/claude-env.json"',
  'rmdir "$BIN_DIR" 2>/dev/null || true',
  'rmdir "$HOME/.toard/state" 2>/dev/null || true',
  'rmdir "$HOME/.toard" 2>/dev/null || true',
  "",
  "# 2) PATH 라인 제거 (# toard shim 마커, 백업 후)",
  'for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do',
  '  [ -f "$rc" ] || continue',
  "  grep -q 'toard shim' \"$rc\" 2>/dev/null || continue",
  '  cp "$rc" "$rc.toard-bak"',
  "  grep -v 'toard shim' \"$rc.toard-bak\" > \"$rc\"",
  '  echo "  PATH 라인 제거: $rc (백업 $rc.toard-bak)"',
  "done",
  "",
  "# 3) codex ~/.codex/config.toml 의 toard [otel] 블록 제거 (마커 사이, 백업 후)",
  'CFG="$HOME/.codex/config.toml"',
  "if [ -f \"$CFG\" ] && grep -q 'toard otel' \"$CFG\" 2>/dev/null; then",
  '  cp "$CFG" "$CFG.toard-bak"',
  "  awk '/# >>> toard otel >>>/{s=1} s==0{print} /# <<< toard otel <<</{s=0}' \"$CFG.toard-bak\" > \"$CFG\"",
  '  echo "  codex [otel] 블록 제거: $CFG (백업 $CFG.toard-bak)"',
  "fi",
  "",
  "echo \"완료 — 새 셸에서 'which claude' 가 shim 이 아니면 성공. 진짜 claude 는 그대로 남아 있습니다.\"",
  "",
].join("\n");
