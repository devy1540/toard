"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { saveTimezoneAction, type TimezoneState } from "./actions";

const INITIAL: TimezoneState = {};

/** 'auto' 센티널 — Select 는 빈 문자열 값을 허용하지 않아 NULL(자동)을 이 값으로 표현. */
const AUTO = "auto";

/**
 * 표시 타임존 선택 — 자동(브라우저) 또는 IANA 수동 선택. initial=null 은 자동.
 * 선택 즉시 저장(테마·색상과 동일 UX) — 별도 저장 버튼 없음. 설정 행의 우측 컨트롤로 렌더.
 */
export function TimezoneForm({ initial }: { initial: string | null }) {
  const t = useTranslations("settings");
  const [state, action, pending] = useActionState(saveTimezoneAction, INITIAL);
  const [value, setValue] = useState(initial ?? AUTO);
  const formRef = useRef<HTMLFormElement>(null);

  // 브라우저가 아는 전체 IANA 목록 + 저장값이 목록에 없을 때의 방어(구형 브라우저 목록 차이)
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    return initial && !list.includes(initial) ? [initial, ...list] : list;
  }, [initial]);
  const browserTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  function onChange(next: string) {
    setValue(next);
    // 상태(hidden input) 반영 후 제출 — 즉시 저장
    requestAnimationFrame(() => formRef.current?.requestSubmit());
  }

  return (
    <form ref={formRef} action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="timezone" value={value === AUTO ? "" : value} />
      {state.error ? <span className="text-destructive text-xs">{state.error}</span> : null}
      {!state.error && state.ok && !pending ? (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("timezone.saved")}</span>
      ) : null}
      <Select value={value} onValueChange={onChange} disabled={pending}>
        <SelectTrigger className="w-full sm:w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>{t("timezone.autoOption", { tz: browserTz })}</SelectItem>
          {zones.map((z) => (
            <SelectItem key={z} value={z}>
              {z}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </form>
  );
}
