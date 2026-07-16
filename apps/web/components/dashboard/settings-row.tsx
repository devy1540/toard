import type { ReactNode } from "react";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/ui/field";
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
  layout = "compact",
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** true 면 우측 정렬 컨트롤 대신 본문형 콘텐츠(좌측 정렬·풀폭) — 패널·프로즈용 */
  wide?: boolean;
  layout?: "compact" | "settings";
  className?: string;
  children: ReactNode;
}) {
  const settingsLayout = layout === "settings";

  return (
    <Field
      orientation={null}
      className={cn(
        settingsLayout
          ? "grid min-w-0 gap-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-center"
          : "flex flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:gap-6",
        !settingsLayout && (wide ? "sm:items-start" : "sm:items-center"),
        className,
      )}
    >
      <FieldContent className={cn("min-w-0 flex-none gap-0", !settingsLayout && "sm:w-52 sm:shrink-0")}>
        <FieldTitle className={cn("w-auto leading-5", settingsLayout ? "font-semibold" : "font-medium")}>
          {label}
        </FieldTitle>
        {description ? (
          <FieldDescription
            className={cn(
              "text-xs leading-4",
              settingsLayout ? "mt-1 max-w-sm last:mt-1" : "mt-0.5 last:mt-0.5",
            )}
          >
            {description}
          </FieldDescription>
        ) : null}
      </FieldContent>
      {settingsLayout ? (
        children
      ) : (
        <div
          className={cn(
            "min-w-0 flex-1",
            wide ? "" : "flex flex-wrap items-center gap-2 sm:justify-end",
          )}
        >
          {children}
        </div>
      )}
    </Field>
  );
}
