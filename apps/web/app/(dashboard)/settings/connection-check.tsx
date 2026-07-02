"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { checkIngestStatusAction, type IngestStatus } from "./connection-actions";

const POLL_MS = 3_000;
const MAX_POLLS = 40; // 2분

type Phase = "idle" | "polling" | "confirmed" | "timeout";

function rel(iso: string): string {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return "방금";
  if (diffMin < 60) return `${diffMin}분 전`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h}시간 전`;
  return new Date(iso).toLocaleString();
}

/**
 * 설치 후 "실제로 데이터가 들어오는지" 를 본인이 즉시 확인하는 컴포넌트.
 * 확인 시작 → last_used_at 이 시작 시점 이후로 갱신될 때까지 폴링(3s × 최대 2분).
 */
export function ConnectionCheck({
  initialHasToken,
  initialLastUsedAt,
}: {
  initialHasToken: boolean;
  initialLastUsedAt: string | null;
}) {
  const [status, setStatus] = useState<IngestStatus>({
    hasToken: initialHasToken,
    lastUsedAt: initialLastUsedAt,
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const runId = useRef(0);

  useEffect(() => {
    // 언마운트 시 진행 중인 폴링 루프 중단
    return () => {
      runId.current += 1;
    };
  }, []);

  const start = async () => {
    const id = ++runId.current;
    setPhase("polling");
    // 시작 시점 스냅샷 — 이보다 "새로운" 수신이 오면 연결 확인 성공
    const baseline = (await checkIngestStatusAction()).lastUsedAt;

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (runId.current !== id) return; // 취소됨
      const s = await checkIngestStatusAction();
      if (runId.current !== id) return;
      setStatus(s);
      if (s.lastUsedAt && s.lastUsedAt !== baseline) {
        setPhase("confirmed");
        return;
      }
    }
    if (runId.current === id) setPhase("timeout");
  };

  const stop = () => {
    runId.current += 1;
    setPhase("idle");
  };

  const dot =
    phase === "confirmed"
      ? "bg-emerald-500"
      : phase === "polling"
        ? "animate-pulse bg-amber-500"
        : status.lastUsedAt
          ? "bg-emerald-500"
          : "bg-muted-foreground/40";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className={`size-2 shrink-0 rounded-full ${dot}`} />
          {phase === "confirmed" ? (
            <span className="font-medium">연결 확인됨 — 방금 수신했습니다.</span>
          ) : phase === "polling" ? (
            <span className="text-muted-foreground">수신 대기 중…</span>
          ) : !status.hasToken ? (
            <span className="text-muted-foreground">토큰 미발급 — 먼저 토큰을 발급하세요.</span>
          ) : status.lastUsedAt ? (
            <span>
              연결됨{" "}
              {/* 상대 시각은 렌더 시점 의존 — SSR 과 달라질 수 있어 클라이언트 값 유지 */}
              <span className="text-muted-foreground" suppressHydrationWarning>
                · 마지막 수신 {rel(status.lastUsedAt)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">아직 수신된 데이터가 없습니다.</span>
          )}
        </div>
        {phase === "polling" ? (
          <Button type="button" variant="outline" size="sm" onClick={stop}>
            중단
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={start}>
            연결 확인
          </Button>
        )}
      </div>

      {phase === "polling" ? (
        <p className="text-muted-foreground text-xs">
          다른 터미널에서 <code>claude</code> 를 한 번 실행해 보세요. 수신되면 자동으로 표시됩니다
          (최대 2분 대기).
        </p>
      ) : null}
      {phase === "timeout" ? (
        <p className="text-destructive text-xs">
          2분 안에 수신되지 않았습니다. shim 설치와 PATH(<code>which claude</code>), 토큰 설정을
          확인한 뒤 다시 시도하세요.
        </p>
      ) : null}
    </div>
  );
}
