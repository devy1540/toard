"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** 클립보드 복사 버튼 — 결과를 토스트로 피드백(성공 문구는 대상별 지정). */
export function CopyButton({
  text,
  label,
  message,
}: {
  text: string;
  label?: string;
  message?: string;
}) {
  const t = useTranslations("common");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success(message ?? t("copiedToClipboard"));
        } catch {
          toast.error(t("copyFailed"));
        }
      }}
    >
      {label ?? t("copy")}
    </Button>
  );
}
