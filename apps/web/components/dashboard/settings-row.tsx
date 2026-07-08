import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 설정 행 — [좌: 라벨(+설명) / 우: 컨트롤] 한 줄. divide-y 컨테이너 안에서 목록으로 쓴다.
 * 행 높이가 곧 내용 높이라 카드 그리드처럼 죽은 공간이 생기지 않는다 (설정 A안 패턴).
 * 서버·클라이언트 어느 쪽에서도 임포트 가능한 순수 프레젠테이션 컴포넌트.
 */
export function SettingsRow({
  label,
  description,
  wide = false,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** true 면 우측 정렬 컨트롤 대신 본문형 콘텐츠(좌측 정렬·풀폭) — 패널·프로즈용 */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:gap-6",
        wide ? "sm:items-start" : "sm:items-center",
      )}
    >
      <div className="min-w-0 sm:w-52 sm:shrink-0">
        <div className="text-sm font-medium">{label}</div>
        {description ? <div className="text-muted-foreground mt-0.5 text-xs">{description}</div> : null}
      </div>
      <div
        className={cn(
          "min-w-0 flex-1",
          wide ? "" : "flex flex-wrap items-center gap-2 sm:justify-end",
        )}
      >
        {children}
      </div>
    </div>
  );
}
