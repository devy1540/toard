"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/dashboard/copy-button";
import { issueTokenAction, type TokenState } from "./token-actions";

const RELEASE_INSTALL = "https://github.com/devy1540/toard/releases/latest/download/install.sh";
const INITIAL: TokenState = {};
const ISSUE_FORM_ID = "issue-token-form";

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
  const placeholder = "<발급으로 토큰 받기>";
  const one = oneLiner(token ?? placeholder, baseUrl);
  // 발급 결과 토스트 — 같은 토큰으로 중복 발화 방지
  const toastedToken = useRef<string | null>(null);

  useEffect(() => {
    if (state.token && toastedToken.current !== state.token) {
      toastedToken.current = state.token;
      toast.success("새 토큰이 발급되었습니다 — 아래 설치 명령에 채워졌습니다.");
    }
  }, [state.token]);
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  // 재발급(=이전 토큰 즉시 폐기)은 파괴적 동작 — 확인 다이얼로그를 거친다. 최초 발급은 바로.
  const reissue = hasToken || Boolean(token);

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
              {/* 로캘·타임존 의존 포맷 — SSR 과 달라질 수 있어 클라이언트 값 유지 */}
              <span className="text-muted-foreground" suppressHydrationWarning>
                (생성 {fmt(createdAt)}
                {lastUsedAt ? ` · 마지막 사용 ${fmt(lastUsedAt)}` : ""})
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">아직 없음</span>
          )}
        </div>
        <form id={ISSUE_FORM_ID} action={action}>
          {reissue ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" disabled={pending}>
                  {pending ? "발급 중…" : "다시 발급"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>토큰을 다시 발급할까요?</AlertDialogTitle>
                  <AlertDialogDescription>
                    이전 토큰은 즉시 폐기됩니다. 기존에 설치한 머신은{" "}
                    <code>~/.toard/credentials</code> 의 토큰을 새 값으로 바꿔야 수집이
                    계속됩니다.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>취소</AlertDialogCancel>
                  <AlertDialogAction type="submit" form={ISSUE_FORM_ID}>
                    다시 발급
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button type="submit" disabled={pending}>
              {pending ? "발급 중…" : "토큰 발급"}
            </Button>
          )}
        </form>
      </div>

      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}

      {token ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">새 토큰 — 지금만 표시됩니다. 아래 명령을 복사해 실행하세요.</p>
          <p className="text-muted-foreground mt-1 text-xs">다시 발급하면 이전 토큰은 즉시 폐기됩니다.</p>
        </div>
      ) : null}

      {/* 쉬운 설치 — 한 줄 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">한 줄 설치 (macOS · Linux)</h2>
          <CopyButton text={one} label="명령 복사" message="설치 명령을 복사했습니다." />
        </div>
        {!token ? (
          <p className="text-muted-foreground text-xs">
            위에서 <b>발급</b> 하면 아래 명령에 내 토큰이 채워집니다.
          </p>
        ) : null}
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">{one}</pre>
        <p className="text-muted-foreground text-xs">
          바이너리 설치 + <code>~/.toard/credentials</code> + PATH 를 자동 설정합니다. endpoint{" "}
          <code>{endpoint}</code> 는 자동 주입. 설치 후 <code>claude</code>/<code>codex</code> 를
          평소처럼 쓰면 사용량이 전송됩니다. Claude Desktop·IDE 확장 사용분까지 수집되도록{" "}
          <code>~/.claude/settings.json</code> 에 텔레메트리 env 도 주입합니다(
          <code>claude-env</code>, 새 세션부터 적용 — 실행 중인 앱은 재시작 필요. 끄려면{" "}
          <code>toard-shim claude-env off</code>).
        </p>
      </div>

      {/* 수동(고급) — 접기 */}
      <details className="text-sm">
        <summary className="text-muted-foreground cursor-pointer select-none">
          직접 설정 (고급)
        </summary>
        <div className="mt-2 flex items-center justify-end">
          <CopyButton
            text={manualSnippet(token ?? placeholder, endpoint)}
            message="수동 설정 명령을 복사했습니다."
          />
        </div>
        <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
          {manualSnippet(token ?? placeholder, endpoint)}
        </pre>
      </details>

      {/* 제거 */}
      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">제거</h2>
          <CopyButton
            text={`curl -fsSL ${baseUrl}/uninstall.sh | sh`}
            label="명령 복사"
            message="제거 명령을 복사했습니다."
          />
        </div>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">{`curl -fsSL ${baseUrl}/uninstall.sh | sh`}</pre>
        <p className="text-muted-foreground text-xs">
          shim · 자격증명 · PATH 설정 · claude-env(<code>settings.json</code>) · codex{" "}
          <code>[otel]</code> 블록을 되돌립니다(각 파일 백업 남김). 진짜 <code>claude</code>/
          <code>codex</code> 는 건드리지 않습니다.
        </p>
      </div>
    </div>
  );
}
