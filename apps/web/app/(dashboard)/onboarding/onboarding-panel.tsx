"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { issueTokenAction, type TokenState } from "./actions";

const INSTALL_URL = "https://github.com/devy1540/toard/releases/latest/download/install.sh";
const INITIAL: TokenState = {};

function snippet(token: string, endpoint: string): string {
  return [
    `curl -fsSL ${INSTALL_URL} | sh`,
    "mkdir -p ~/.toard && chmod 700 ~/.toard",
    "cat > ~/.toard/credentials <<'EOF'",
    `agent_key=${token}`,
    `endpoint=${endpoint}`,
    "EOF",
    "chmod 600 ~/.toard/credentials",
    'export PATH="$HOME/.toard/bin:$PATH"   # ~/.zshrc 에 추가',
  ].join("\n");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard 미지원 무시 */
        }
      }}
    >
      {copied ? "복사됨" : "복사"}
    </Button>
  );
}

export function OnboardingPanel({
  endpoint,
  hasToken,
  createdAt,
  lastUsedAt,
}: {
  endpoint: string;
  hasToken: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}) {
  const [state, action, pending] = useActionState(issueTokenAction, INITIAL);
  const token = state.token;
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
  const snippetText = snippet(token ?? "<발급/재발급으로 토큰 받기>", endpoint);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="text-muted-foreground">내 ingest 토큰: </span>
          {token ? (
            <span>
              발급됨 <span className="text-muted-foreground">(방금)</span>
            </span>
          ) : hasToken ? (
            <span>
              발급됨{" "}
              <span className="text-muted-foreground">
                (생성 {fmt(createdAt)}
                {lastUsedAt ? ` · 마지막 사용 ${fmt(lastUsedAt)}` : ""})
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">아직 없음</span>
          )}
        </div>
        <form action={action}>
          <Button type="submit" disabled={pending}>
            {pending ? "발급 중…" : hasToken || token ? "재발급(회전)" : "토큰 발급"}
          </Button>
        </form>
      </div>

      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}

      {token ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">새 토큰 — 지금만 표시됩니다. 복사해두세요.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-muted overflow-x-auto rounded px-2 py-1 text-xs">{token}</code>
            <CopyButton text={token} />
          </div>
          <p className="text-muted-foreground mt-1 text-xs">재발급하면 이전 토큰은 즉시 폐기됩니다.</p>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">설치 (macOS · Linux)</h2>
          <CopyButton text={snippetText} />
        </div>
        {!token ? (
          <p className="text-muted-foreground text-xs">
            토큰 평문은 발급 시 1회만 노출됩니다. 아래 <code>agent_key</code> 를 채우려면 위에서{" "}
            <b>발급/재발급</b> 하세요.
          </p>
        ) : null}
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
          {snippetText}
        </pre>
        <p className="text-muted-foreground text-xs">
          endpoint <code>{endpoint}</code> · 설치 후 <code>claude</code>/<code>codex</code> 를 평소처럼
          쓰면 사용량이 자동 전송됩니다. (<code>npx</code> 설치는 아직 미제공)
        </p>
      </div>
    </div>
  );
}
