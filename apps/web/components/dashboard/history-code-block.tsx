"use client";

import { useId, useState } from "react";
import { Check, Copy, Rows3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

function displayLang(lang?: string): string {
  const raw = lang?.trim();
  return raw ? raw.split(/\s+/)[0]!.toUpperCase() : "CODE";
}

export function HistoryCodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [mode, setMode] = useState<"read" | "raw">("read");
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const commonT = useTranslations("common");
  const t = useTranslations("dashboard");
  const codeLines = code.length === 0 ? [""] : code.split("\n");
  const isRead = mode === "read";

  return (
    <section className="overflow-hidden rounded-lg border bg-muted/20" aria-labelledby={titleId}>
      <div className="flex min-h-11 flex-col gap-2 border-b bg-background/80 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <span id={titleId} className="text-foreground font-semibold tracking-wide">
            {displayLang(lang)}
          </span>
          <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
            {isRead ? t("history.codeReadMode") : t("history.codeRawMode")}
          </span>
          <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
            {t("history.codeLines", { count: codeLines.length })}
          </span>
          <span className="hidden truncate text-muted-foreground sm:inline">
            {isRead ? t("history.codeReadHint") : t("history.codeRawHint")}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant={isRead ? "outline" : "ghost"}
            size="sm"
            className={isRead ? "h-8 border-primary/30 bg-primary/10 px-2.5 text-xs text-primary" : "h-8 px-2.5 text-xs"}
            aria-pressed={isRead}
            onClick={() => setMode("read")}
          >
            <Rows3 className="size-3.5" />
            {t("history.codeRead")}
          </Button>
          <Button
            type="button"
            variant={!isRead ? "outline" : "ghost"}
            size="sm"
            className={!isRead ? "h-8 border-primary/30 bg-primary/10 px-2.5 text-xs text-primary" : "h-8 px-2.5 text-xs"}
            aria-pressed={!isRead}
            onClick={() => setMode("raw")}
          >
            {t("history.codeRaw")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
                toast.success(t("history.codeCopied"));
                window.setTimeout(() => setCopied(false), 1200);
              } catch {
                toast.error(commonT("copyFailed"));
              }
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {commonT("copy")}
          </Button>
        </div>
      </div>
      <div
        className={
          isRead ? "max-h-[38rem] overflow-auto font-mono text-xs leading-6" : "max-h-[38rem] overflow-auto"
        }
      >
        {isRead ? (
          <div className="py-2">
            {codeLines.map((line, index) => (
              <div key={index} className="grid grid-cols-[3.25rem_minmax(0,1fr)] odd:bg-background/35">
                <span className="border-r bg-muted/30 pr-3 text-right text-muted-foreground/70 tabular-nums select-none">
                  {index + 1}
                </span>
                <code className="min-w-0 px-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {line || " "}
                </code>
              </div>
            ))}
          </div>
        ) : (
          <pre className="min-w-max px-3 py-2 font-mono text-xs leading-5 whitespace-pre">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </section>
  );
}
