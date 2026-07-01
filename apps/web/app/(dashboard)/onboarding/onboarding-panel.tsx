"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { issueTokenAction, type TokenState } from "./actions";

const RELEASE_INSTALL = "https://github.com/devy1540/toard/releases/latest/download/install.sh";
const INITIAL: TokenState = {};

/** 한 줄 설치 — toard 가 서빙하는 install.sh 에 토큰을 env 로 넘김(바이너리+자격+PATH 자동). */
function oneLiner(token: string, baseUrl: string): string {
  return `curl -fsSL ${baseUrl}/install.sh | TOARD_INGEST_TOKEN=${token} sh`;
}

/** 수동(고급) — 릴리스 install.sh + 직접 자격/PATH 설정. */
function manualSnippet(token: string, endpoint: string): string {
  return [
    `curl -fsSL ${RELEASE_INSTALL} | sh`,
    "mkdir -p ~/.toard && chmod 700 ~/.toard",
    "cat > ~/.toard/credentials <<'EOF'",
    `agent_key=${token}`,
    `endpoint=${endpoint}`,
    "EOF",
    "chmod 600 ~/.toard/credentials",
    'export PATH="$HOME/.toard/bin:$PATH"   # ~/.zshrc 에 추가',
  ].join("\n");
}

function CopyButton({ text, label = "복사" }: { text: string; label?: string }) {
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
      {copied ? "복사됨" : label}
    </Button>
  );
}

export function OnboardingPanel({
  baseUrl,
  endpoint,
  hasToken,
  createdAt,
  lastUsedAt,
}: {
  baseUrl: string;
  endpoint: string;
  hasToken: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}) {
  const [state, action, pending] = useActionState(issueTokenAction, INITIAL);
  const token = state.token;
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
  const placeholder = "<발급/재발급으로 토큰 받기>";
  const one = oneLiner(token ?? placeholder, baseUrl);

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
          <p className="font-medium">새 토큰 — 지금만 표시됩니다. 아래 명령을 복사해 실행하세요.</p>
          <p className="text-muted-foreground mt-1 text-xs">재발급하면 이전 토큰은 즉시 폐기됩니다.</p>
        </div>
      ) : null}

      {/* 쉬운 설치 — 한 줄 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">한 줄 설치 (macOS · Linux)</h2>
          <CopyButton text={one} label="명령 복사" />
        </div>
        {!token ? (
          <p className="text-muted-foreground text-xs">
            위에서 <b>발급/재발급</b> 하면 아래 명령에 내 토큰이 채워집니다.
          </p>
        ) : null}
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">{one}</pre>
        <p className="text-muted-foreground text-xs">
          바이너리 설치 + <code>~/.toard/credentials</code> + PATH 를 자동 설정합니다. endpoint{" "}
          <code>{endpoint}</code> 는 자동 주입. 설치 후 <code>claude</code>/<code>codex</code> 를
          평소처럼 쓰면 사용량이 전송됩니다.
        </p>
      </div>

      {/* 수동(고급) — 접기 */}
      <details className="text-sm">
        <summary className="text-muted-foreground cursor-pointer select-none">
          직접 설정 (고급)
        </summary>
        <div className="mt-2 flex items-center justify-end">
          <CopyButton text={manualSnippet(token ?? placeholder, endpoint)} />
        </div>
        <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
          {manualSnippet(token ?? placeholder, endpoint)}
        </pre>
      </details>
    </div>
  );
}
