"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Languages } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { locales, localeNames, type Locale } from "@/i18n/config";
import { setUserLocale } from "@/i18n/locale";

/** 쿠키 기반 언어 스위처. 선택 시 쿠키 저장 후 서버 컴포넌트를 새로 렌더한다. */
export function LanguageToggle() {
  const locale = useLocale();
  const t = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onChange(next: string) {
    startTransition(async () => {
      await setUserLocale(next as Locale);
      router.refresh();
    });
  }

  return (
    <Select value={locale} onValueChange={onChange} disabled={pending}>
      <SelectTrigger className="gap-1.5" aria-label={t("changeLanguage")}>
        <Languages className="size-4" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {locales.map((l) => (
          <SelectItem key={l} value={l}>
            {localeNames[l]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
