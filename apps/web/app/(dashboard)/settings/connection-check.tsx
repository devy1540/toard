"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatVersion, isShimOutdated } from "@toard/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { checkIngestStatusAction, type IngestStatus } from "./connection-actions";

const POLL_MS = 3_000;
const MAX_POLLS = 40; // 2분

type Phase = "idle" | "polling" | "confirmed" | "timeout";

/**
 * 설치 후 "실제로 데이터가 들어오는지" 를 본인이 즉시 확인하는 컴포넌트.
 * 확인 시작 → last_used_at 이 시작 시점 이후로 갱신될 때까지 폴링(3s × 최대 2분).
 */
export function ConnectionCheck({
  initialHasToken,
  initialLastUsedAt,
  initialShimVersion,
  serverVersion,
}: {
  initialHasToken: boolean;
  initialLastUsedAt: string | null;
  initialShimVersion: string | null;
  serverVersion: string;
}) {
  const t = useTranslations("settings");
  const [status, setStatus] = useState<IngestStatus>({
    hasToken: initialHasToken,
    lastUsedAt: initialLastUsedAt,
    shimVersion: initialShimVersion,
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const runId = useRef(0);

  const rel = (iso: string): string => {
    const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (diffMin < 1) return t("connection.justNow");
    if (diffMin < 60) return t("connection.minutesAgo", { n: diffMin });
    const h = Math.floor(diffMin / 60);
    if (h < 24) return t("connection.hoursAgo", { h });
    return new Date(iso).toLocaleString();
  };

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
            <span className="font-medium">{t("connection.confirmed")}</span>
          ) : phase === "polling" ? (
            <span className="text-muted-foreground">{t("connection.waiting")}</span>
          ) : !status.hasToken ? (
            <span className="text-muted-foreground">{t("connection.noToken")}</span>
          ) : status.lastUsedAt ? (
            <span>
              {t("connection.connected")}{" "}
              {/* 상대 시각은 렌더 시점 의존 — SSR 과 달라질 수 있어 클라이언트 값 유지 */}
              <span className="text-muted-foreground" suppressHydrationWarning>
                {t("connection.lastReceived", { rel: rel(status.lastUsedAt) })}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{t("connection.noData")}</span>
          )}
        </div>
        {phase === "polling" ? (
          <Button type="button" variant="outline" size="sm" onClick={stop}>
            {t("connection.stop")}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={start}>
            {t("connection.check")}
          </Button>
        )}
      </div>

      {/* 마지막으로 수신한 기기의 shim 버전 — 구버전이면 배지로 경고 */}
      {status.shimVersion ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <span>
            shim <span className="font-mono">{formatVersion(status.shimVersion)}</span>
          </span>
          {isShimOutdated(status.shimVersion, serverVersion) ? (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-500"
            >
              {t("install.shimOutdated")}
            </Badge>
          ) : null}
        </p>
      ) : null}

      {phase === "polling" ? (
        <p className="text-muted-foreground text-xs">
          {t.rich("connection.pollingHint", { code: (chunks) => <code>{chunks}</code> })}
        </p>
      ) : null}
      {phase === "timeout" ? (
        <p className="text-destructive text-xs">
          {t.rich("connection.timeoutHint", { code: (chunks) => <code>{chunks}</code> })}
        </p>
      ) : null}
    </div>
  );
}
