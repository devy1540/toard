"use client";

import { useActionState, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { saveTimezoneAction, type TimezoneState } from "./actions";

const INITIAL: TimezoneState = {};

/** 'auto' 센티널 — Select 는 빈 문자열 값을 허용하지 않아 NULL(자동)을 이 값으로 표현. */
const AUTO = "auto";

/** 표시 타임존 선택 — 자동(브라우저) 또는 IANA 수동 선택. initial=null 은 자동. */
export function TimezoneForm({ initial }: { initial: string | null }) {
  const t = useTranslations("settings");
  const [state, action, pending] = useActionState(saveTimezoneAction, INITIAL);
  const [value, setValue] = useState(initial ?? AUTO);

  // 브라우저가 아는 전체 IANA 목록 + 저장값이 목록에 없을 때의 방어(구형 브라우저 목록 차이)
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    return initial && !list.includes(initial) ? [initial, ...list] : list;
  }, [initial]);
  const browserTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="timezone" value={value === AUTO ? "" : value} />
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger className="w-full sm:w-80">
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
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.ok ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{t("timezone.saved")}</p>
      ) : null}
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t("timezone.saving") : t("timezone.save")}
      </Button>
    </form>
  );
}
