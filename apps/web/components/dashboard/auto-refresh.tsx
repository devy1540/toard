"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const OPTIONS = [
  { v: "off", l: "자동 새로고침 끔", ms: 0 },
  { v: "10", l: "10초", ms: 10_000 },
  { v: "30", l: "30초", ms: 30_000 },
  { v: "60", l: "1분", ms: 60_000 },
  { v: "300", l: "5분", ms: 300_000 },
];

const STORAGE_KEY = "toard:auto-refresh";

/** 페이지를 리로드하지 않고 서버 데이터만 다시 가져오는 새로고침 컨트롤.
 *  force-dynamic 페이지에서 router.refresh() 로 RSC 데이터만 갱신(스크롤·필터 상태 유지).
 *  수동 버튼 + 주기 선택(localStorage 저장), 탭이 백그라운드면 주기 새로고침을 건너뜀. */
export function AutoRefresh() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState("off");
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [ago, setAgo] = useState("");
  // interval 콜백이 매 tick 최신 refresh 를 참조하도록 ref 로 유지(재구독 없이).
  const refreshRef = useRef<() => void>(() => {});

  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
      setLastAt(Date.now());
    });
  }, [router]);
  refreshRef.current = refresh;

  // 저장된 선택값 복원 + 최초 마운트 시각 기록.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && OPTIONS.some((o) => o.v === saved)) setValue(saved);
    setLastAt(Date.now());
  }, []);

  const onChange = (v: string) => {
    setValue(v);
    localStorage.setItem(STORAGE_KEY, v);
  };

  // 선택 주기마다 새로고침 — 탭이 보일 때만.
  useEffect(() => {
    const ms = OPTIONS.find((o) => o.v === value)?.ms ?? 0;
    if (ms <= 0) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, ms);
    return () => clearInterval(id);
  }, [value]);

  // "n초 전" 라벨 갱신 — 1초 tick.
  useEffect(() => {
    if (lastAt === null) return;
    const tick = () => {
      const s = Math.max(0, Math.round((Date.now() - lastAt) / 1000));
      setAgo(s < 5 ? "방금" : s < 60 ? `${s}초 전` : `${Math.floor(s / 60)}분 전`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastAt]);

  return (
    <div className="flex items-center gap-1">
      {ago ? (
        <span className="text-muted-foreground mr-1 hidden text-xs tabular-nums sm:inline">
          {ago} 업데이트
        </span>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={refresh}
        disabled={isPending}
        aria-label="지금 새로고침"
        title="지금 새로고침"
      >
        <RefreshCw className={`size-4 ${isPending ? "animate-spin" : ""}`} />
      </Button>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-32" aria-label="자동 새로고침 주기">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OPTIONS.map((o) => (
            <SelectItem key={o.v} value={o.v}>
              {o.l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
