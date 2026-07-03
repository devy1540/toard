"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** 클립보드 복사 버튼 — 결과를 토스트로 피드백(성공 문구는 대상별 지정). */
export function CopyButton({
  text,
  label = "복사",
  message = "클립보드에 복사했습니다.",
}: {
  text: string;
  label?: string;
  message?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success(message);
        } catch {
          toast.error("복사하지 못했습니다 — 브라우저 클립보드 권한을 확인하세요.");
        }
      }}
    >
      {label}
    </Button>
  );
}
