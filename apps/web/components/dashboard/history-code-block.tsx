"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Check, Copy, GitBranch, Rows3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type CodeMode = "diagram" | "read" | "raw";

let mermaidInitialized = false;

function displayLang(lang?: string): string {
  const raw = lang?.trim();
  return raw ? raw.split(/\s+/)[0]!.toUpperCase() : "CODE";
}

function isMermaidLang(lang?: string): boolean {
  const raw = lang?.trim().split(/\s+/)[0]?.toLowerCase();
  return raw === "mermaid" || raw === "mmd";
}

function modeButtonClass(active: boolean): string {
  return active ? "h-8 border-primary/30 bg-primary/10 px-2.5 text-xs text-primary" : "h-8 px-2.5 text-xs";
}

async function renderMermaid(id: string, code: string): Promise<string> {
  const mermaid = (await import("mermaid")).default;

  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      flowchart: {
        htmlLabels: true,
      },
      themeVariables: {
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        primaryColor: "#fff7ed",
        primaryTextColor: "#18181b",
        primaryBorderColor: "#fdba74",
        lineColor: "#71717a",
        secondaryColor: "#f4f4f5",
        tertiaryColor: "#ffffff",
      },
    });
    mermaidInitialized = true;
  }

  const { svg } = await mermaid.render(id, code);
  return svg;
}

function HistoryMermaidDiagram({ code }: { code: string }) {
  const reactId = useId();
  const diagramId = useMemo(() => `history-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [reactId]);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const t = useTranslations("dashboard");

  useEffect(() => {
    let ignore = false;

    setSvg(null);
    setError(false);
    renderMermaid(diagramId, code)
      .then((nextSvg) => {
        if (!ignore) {
          setSvg(nextSvg);
        }
      })
      .catch(() => {
        if (!ignore) {
          setError(true);
        }
      });

    return () => {
      ignore = true;
    };
  }, [code, diagramId]);

  return (
    <div className="max-h-[38rem] overflow-auto bg-white p-4 text-zinc-950">
      {error ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {t("history.codeDiagramFailed")}
        </div>
      ) : svg ? (
        <div
          className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="text-muted-foreground rounded-md border bg-background px-3 py-2 text-sm">
          {t("history.codeDiagramRendering")}
        </div>
      )}
    </div>
  );
}

export function HistoryCodeBlock({ code, lang }: { code: string; lang?: string }) {
  const isMermaid = isMermaidLang(lang);
  const [mode, setMode] = useState<CodeMode>(isMermaid ? "diagram" : "read");
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const commonT = useTranslations("common");
  const t = useTranslations("dashboard");
  const codeLines = code.length === 0 ? [""] : code.split("\n");
  const isDiagram = isMermaid && mode === "diagram";
  const isRead = mode === "read";
  const isRaw = mode === "raw";
  const modeLabel = isDiagram
    ? t("history.codeDiagramMode")
    : isRead
      ? t("history.codeReadMode")
      : t("history.codeRawMode");
  const modeHint = isDiagram
    ? t("history.codeDiagramHint")
    : isRead
      ? t("history.codeReadHint")
      : t("history.codeRawHint");

  return (
    <section className="overflow-hidden rounded-lg border bg-muted/20" aria-labelledby={titleId}>
      <div className="flex min-h-11 flex-col gap-2 border-b bg-background/80 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <span id={titleId} className="text-foreground font-semibold tracking-wide">
            {displayLang(lang)}
          </span>
          <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
            {modeLabel}
          </span>
          <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
            {t("history.codeLines", { count: codeLines.length })}
          </span>
          <span className="hidden truncate text-muted-foreground sm:inline">
            {modeHint}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isMermaid ? (
            <Button
              type="button"
              variant={isDiagram ? "outline" : "ghost"}
              size="sm"
              className={modeButtonClass(isDiagram)}
              aria-pressed={isDiagram}
              onClick={() => setMode("diagram")}
            >
              <GitBranch className="size-3.5" />
              {t("history.codeDiagram")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={isRead ? "outline" : "ghost"}
            size="sm"
            className={modeButtonClass(isRead)}
            aria-pressed={isRead}
            onClick={() => setMode("read")}
          >
            <Rows3 className="size-3.5" />
            {t("history.codeRead")}
          </Button>
          <Button
            type="button"
            variant={isRaw ? "outline" : "ghost"}
            size="sm"
            className={modeButtonClass(isRaw)}
            aria-pressed={isRaw}
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
          isDiagram
            ? ""
            : isRead
              ? "max-h-[38rem] overflow-auto font-mono text-xs leading-6"
              : "max-h-[38rem] overflow-auto"
        }
      >
        {isDiagram ? (
          <HistoryMermaidDiagram code={code} />
        ) : isRead ? (
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
